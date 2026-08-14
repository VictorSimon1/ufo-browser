import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const sourceApp = join(root, "release-native/UFO-Browser.app");
const installRoot = await mkdtemp(join(tmpdir(), "ufo-native-install-smoke-"));
const appRoot = join(installRoot, "UFO-Browser.app");
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
