import { spawn } from "node:child_process";
import { access, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const root = process.cwd();
const releaseRoot = resolve(root, "release");
const mode = process.argv.includes("--release")
  ? "release"
  : process.argv.includes("--temporary")
    ? "temporary"
    : process.argv.includes("--dir")
      ? "dir"
      : null;

if (!mode) {
  throw new Error("Use --dir, --temporary, or --release");
}
if (process.platform !== "darwin") {
  throw new Error("UFO-Browser macOS packaging must run on macOS");
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${signal || code})`,
          ),
        );
      }
    });
  });
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function resetReleaseDirectory() {
  if (dirname(releaseRoot) !== root || basename(releaseRoot) !== "release") {
    throw new Error(`Refusing unsafe release path: ${releaseRoot}`);
  }
  await rm(releaseRoot, { recursive: true, force: true });
}

async function packageApplication() {
  const builder = join(root, "node_modules/.bin/electron-builder");
  await access(builder);
  const args = ["--mac", "dir"];
  const electronDist = join(root, "node_modules/electron/dist");
  if (await pathExists(join(electronDist, "Electron.app"))) {
    args.push(`--config.electronDist=${electronDist}`);
  }
  await run(builder, args);
}

async function findPackagedApp() {
  const files = await collectFiles(releaseRoot);
  const appExecutable = files.find((path) =>
    path.endsWith("UFO-Browser.app/Contents/MacOS/UFO-Browser"),
  );
  if (!appExecutable) throw new Error("Packaged UFO-Browser.app was not found");
  return appExecutable.slice(0, -"/Contents/MacOS/UFO-Browser".length);
}

async function createArchives(appRoot) {
  const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const artifactBase = `UFO-Browser-${packageInfo.version}-${process.arch}`;
  const zipPath = join(releaseRoot, `${artifactBase}-mac.zip`);
  const dmgPath = join(releaseRoot, `${artifactBase}.dmg`);
  await rm(zipPath, { force: true });
  await rm(dmgPath, { force: true });
  await run("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appRoot,
    zipPath,
  ]);
  await run("/usr/bin/hdiutil", [
    "create",
    "-volname",
    `UFO-Browser ${packageInfo.version}`,
    "-srcfolder",
    dirname(appRoot),
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ]);
}

async function verifyArtifacts(appRoot, expectArchives) {
  const files = await collectFiles(releaseRoot);
  const required = [
    "Contents/Resources/app.asar",
    "Contents/Resources/icon.icns",
    "Contents/Resources/icon.png",
    "Contents/Resources/skills/ufo-browser/SKILL.md",
    "Contents/Resources/skills/ufo-browser/agents/openai.yaml",
    "Contents/Resources/app.asar.unpacked/dist/bin/ufo-keychain-helper",
  ];
  for (const relative of required) await access(join(appRoot, relative));

  const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const archives = files.filter((path) => /\.(dmg|zip)$/.test(path));
  if (expectArchives) {
    if (!archives.some((path) => path.endsWith(".dmg"))) {
      throw new Error("DMG artifact was not created");
    }
    if (!archives.some((path) => path.endsWith(".zip"))) {
      throw new Error("ZIP artifact was not created");
    }
  }

  console.log(`Verified ${packageInfo.productName || packageInfo.build.productName} ${packageInfo.version}`);
  console.log(`  App: ${appRoot}`);
  if (expectArchives) {
    for (const archive of archives) {
      const info = await stat(archive);
      console.log(`  Artifact: ${archive} (${(info.size / 1024 / 1024).toFixed(1)} MiB)`);
    }
  }
}

console.log(`UFO-Browser macOS packaging mode: ${mode}`);
if (mode === "release") {
  await resetReleaseDirectory();
  await run("npm", ["run", "typecheck"]);
  await run("npm", ["test"]);
  await run(process.execPath, ["scripts/sync-agent-skills.mjs"]);
  await run("npm", ["run", "build"]);
  await packageApplication();
  const appRoot = await findPackagedApp();
  await createArchives(appRoot);
  await verifyArtifacts(appRoot, true);
} else if (mode === "temporary") {
  await run("npm", ["run", "typecheck"]);
  await run("npm", ["run", "build"]);
  await packageApplication();
  const appRoot = await findPackagedApp();
  await createArchives(appRoot);
  await verifyArtifacts(appRoot, true);
} else {
  await run("npm", ["run", "build"]);
  await packageApplication();
  const appRoot = await findPackagedApp();
  await verifyArtifacts(appRoot, false);
}
