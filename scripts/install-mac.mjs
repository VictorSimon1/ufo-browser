import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = "/Applications/UFO-Browser.app";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: options.stdio || "inherit",
      ...options,
    });
    let output = "";
    if (child.stdout) child.stdout.on("data", (chunk) => (output += chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal || code})\n${output}`));
    });
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function mountedDmg(dmgPath) {
  const mountRoot = await mkdtemp(join(tmpdir(), "ufo-browser-dmg-install-"));
  try {
    await run("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountRoot,
      dmgPath,
    ]);
    return mountRoot;
  } catch (error) {
    await rm(mountRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function stopInstalledApp() {
  const pgrep = await run("/usr/bin/pgrep", ["-x", "UFO-Browser"], {
    stdio: ["ignore", "pipe", "ignore"],
  }).catch(() => "");
  const pids = pgrep.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (pids.length) await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
}

async function verifyInstalledApp(appRoot) {
  const plistPath = join(appRoot, "Contents/Info.plist");
  const bundleId = (await run("/usr/libexec/PlistBuddy", [
    "-c", "Print :CFBundleIdentifier", plistPath,
  ], { stdio: ["ignore", "pipe", "pipe"] })).trim();
  const native = bundleId === "com.ufobrowser.app.native";
  const required = native
    ? [
        "Contents/MacOS/ufo-browser-native",
        "Contents/Resources/node",
        "Contents/Resources/native-cef-agent.js",
        "Contents/Resources/native-cef-application.js",
        "Contents/Resources/profile-sync-storage-revision-worker.js",
        "Contents/MacOS/ufo-cef-host",
        "Contents/Resources/ufo-browser",
        "Contents/Resources/x-browser",
        "Contents/Resources/skills/ufo-browser/SKILL.md",
        "Contents/Resources/skills/ufo-browser/agents/openai.yaml",
        "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Chromium Embedded Framework",
      ]
    : [
        "Contents/MacOS/UFO-Browser",
        "Contents/Resources/app.asar",
        "Contents/Resources/app.asar.unpacked/dist/bin/ufo-browser",
        "Contents/Resources/app.asar.unpacked/dist/bin/x-browser",
        "Contents/Resources/skills/ufo-browser/SKILL.md",
        "Contents/Resources/skills/ufo-browser/agents/openai.yaml",
      ];
  for (const relative of required) await access(join(appRoot, relative));
  const plist = await run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    plistPath,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const version = plist.trim();
  if (!version) throw new Error("Installed App does not contain a readable version");
  console.log(`Installed ${native ? "Native CEF" : "Electron"} App verified: ${appRoot} (v${version})`);
  return native;
}

async function main() {
  if (process.platform !== "darwin") throw new Error("DMG installation is only supported on macOS");
  const positional = process.argv.slice(2).find((arg, index, args) => {
    if (arg.startsWith("--")) return false;
    return args[index - 1] !== "--app" && args[index - 1] !== "--dmg";
  });
  const input = positional || argumentValue("--dmg");
  if (!input) throw new Error("Usage: npm run install:mac -- path/to/UFO-Browser.dmg");
  const dmgPath = resolve(input);
  if (!dmgPath.toLowerCase().endsWith(".dmg")) throw new Error(`Expected a .dmg file: ${dmgPath}`);
  await access(dmgPath);

  const mountRoot = await mountedDmg(dmgPath);
  const sourceApp = join(mountRoot, "UFO-Browser.app");
  let replaced = false;
  const stagingApp = join("/Applications", `.UFO-Browser.app.install-${process.pid}`);
  const backupApp = join("/Applications", `.UFO-Browser.app.previous-${process.pid}`);
  try {
    await lstat(sourceApp);
    await stopInstalledApp();
    await rm(stagingApp, { recursive: true, force: true });
    await rm(backupApp, { recursive: true, force: true });
    await run("/usr/bin/ditto", [sourceApp, stagingApp]);
    if (await pathExists(destination)) await rename(destination, backupApp);
    try {
      await rename(stagingApp, destination);
      replaced = true;
    } catch (error) {
      if (await pathExists(backupApp) && !(await pathExists(destination))) await rename(backupApp, destination);
      throw error;
    }
    const native = await verifyInstalledApp(destination);
    await run(process.execPath, ["scripts/install-local-cli.mjs", "--app", destination, "--force"]);
    await run(process.execPath, ["scripts/sync-agent-skills.mjs", "--source", join(destination, "Contents/Resources/skills/ufo-browser")]);
    console.log(`CLI and Agent Skills synchronized from ${destination}`);
  } finally {
    await rm(stagingApp, { recursive: true, force: true }).catch(() => {});
    if (replaced) await rm(backupApp, { recursive: true, force: true }).catch(() => {});
    await run("/usr/bin/hdiutil", ["detach", mountRoot, "-force"], { stdio: "ignore" }).catch(() => {});
    await rm(mountRoot, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
