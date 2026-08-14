import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { hashSkillDirectory } from "./sync-agent-skills.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const sourceApp = join(root, "release-native/UFO-Browser.app");
const installRoot = await mkdtemp(join(tmpdir(), "ufo-native-install-smoke-"));
const appRoot = join(installRoot, "UFO-Browser.app");
const isolatedHome = join(installRoot, "home");
const isolatedBin = join(isolatedHome, ".local/bin");
await copyBundle(sourceApp, appRoot);
const launcher = join(appRoot, "Contents/MacOS/ufo-browser-native");
const userData = join(installRoot, "UserData");
for (const path of [
  launcher,
  join(appRoot, "Contents/MacOS/ufo-cef-host"),
  join(appRoot, "Contents/Resources/renderer/overview.html"),
  join(appRoot, "Contents/Resources/native-cef-agent.js"),
  join(appRoot, "Contents/Resources/skills/ufo-browser/SKILL.md"),
]) await access(path);
const skillContents = await readFile(join(appRoot, "Contents/Resources/skills/ufo-browser/SKILL.md"), "utf8");
if (!/^---[\s\S]*?^name:\s*ufo-browser\s*$/m.test(skillContents)) throw new Error("Native bundle Skill frontmatter is invalid");
if (await exists(join(appRoot, "Contents/Resources/app.asar"))) throw new Error("Native install contains app.asar");

// Exercise the same post-install hooks used by install-mac.mjs, but inside an
// isolated HOME. This proves a dragged-in DMG updates the CLI and each
// installed agent's Skill directory without touching the developer machine.
for (const agentHome of [".claude", ".codex", ".agents"]) {
  await mkdir(join(isolatedHome, agentHome), { recursive: true, mode: 0o700 });
}
await mkdir(isolatedBin, { recursive: true, mode: 0o700 });
const resolvedAppRoot = await realpath(appRoot);
const syncEnv = {
  ...process.env,
  HOME: isolatedHome,
  CODEX_HOME: join(isolatedHome, ".codex"),
  UFO_BROWSER_CLI_BIN: isolatedBin,
};
await runNode(join(root, "scripts/install-local-cli.mjs"), ["--app", appRoot, "--force"], syncEnv);
for (const name of ["ufo-browser", "x-browser"]) {
  const link = join(isolatedBin, name);
  const target = await realpath(link);
  if (target !== join(resolvedAppRoot, "Contents/Resources", name)) {
    throw new Error(`Installed ${name} CLI points to ${target}, expected the DMG App bundle`);
  }
}
const sourceSkill = join(appRoot, "Contents/Resources/skills/ufo-browser");
const expectedHash = await hashSkillDirectory(sourceSkill);
await runNode(join(root, "scripts/sync-agent-skills.mjs"), ["--source", sourceSkill], syncEnv);
for (const targetRoot of [
  join(isolatedHome, ".claude/skills/ufo-browser"),
  join(isolatedHome, ".codex/skills/ufo-browser"),
  join(isolatedHome, ".agents/skills/ufo-browser"),
]) {
  const markerPath = join(targetRoot, ".ufo-browser-managed.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (marker.managedBy !== "UFO-Browser" || marker.skill !== "ufo-browser" || marker.sourceHash !== expectedHash) {
    throw new Error(`Skill marker is invalid: ${markerPath}`);
  }
  if (await hashSkillDirectory(targetRoot) !== expectedHash) {
    throw new Error(`Installed Skill hash mismatch: ${targetRoot}`);
  }
}

const app = spawn(launcher, [], {
  cwd: appRoot,
  env: {
    ...process.env,
    UFO_BROWSER_NATIVE_USER_DATA: userData,
    UFO_BROWSER_SOURCE_PARTITIONS: join(userData, "NoSource"),
    UFO_CEF_USE_MOCK_KEYCHAIN: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
app.stderr.setEncoding("utf8");
app.stderr.on("data", (chunk) => { stderr += chunk; });
try {
  // In headless CI/macOS sessions CEF may close the window after startup and
  // remove the socket during teardown. The coordinator's overview.json is a
  // more stable proof that the relocated App reached the Native CEF runtime.
  await waitForFile(join(userData, "overview.json"), app, 20_000);
  await waitForFile(join(userData, "ufo-browser.sock"), app, 20_000).catch(() => undefined);
  const processes = await ps();
  if (processes.some((line) => /(^|\s)(electron|Electron)(\s|$)/.test(line))) {
    throw new Error(`Native installation launched Electron: ${processes.join("\n")}`);
  }
  console.log(JSON.stringify({ installedApp: appRoot, nativeOnly: true }));
} finally {
  if (app.exitCode === null) app.kill("SIGTERM");
  await waitForExit(app, 5_000).catch(() => undefined);
  await rm(installRoot, { recursive: true, force: true });
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function copyBundle(source, destination) {
  await new Promise((resolveCopy, rejectCopy) => {
    const child = spawn("/usr/bin/ditto", [source, destination], { stdio: "ignore" });
    child.once("error", rejectCopy);
    child.once("exit", (code) => code === 0 ? resolveCopy() : rejectCopy(new Error(`ditto failed (${code})`)));
  });
}

async function runNode(script, args, env) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) return resolveRun();
      rejectRun(new Error(`${script} failed (${code})\n${output}${error}`));
    });
  });
}

async function ps() {
  return new Promise((resolvePs, rejectPs) => {
    const child = spawn("/bin/ps", ["-axo", "command"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectPs);
    child.once("exit", (code) => code === 0 ? resolvePs(output.split("\n")) : rejectPs(new Error(`ps failed (${code})`)));
  });
}

async function waitForFile(path, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Native app exited (${child.exitCode})\n${stderr}`);
    try { await access(path); return; } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Native app did not start: ${path}\n${stderr}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("process exit timed out")), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); rejectExit(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolveExit(code ?? 1); });
  });
}
