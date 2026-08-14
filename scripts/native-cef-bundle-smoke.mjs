import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const appRoot = join(root, "release-native/UFO-Browser.app");
const launcher = join(appRoot, "Contents/MacOS/UFO-Browser");
const cli = join(appRoot, "Contents/Resources/ufo-browser");
const storageWorker = join(appRoot, "Contents/Resources/profile-sync-storage-revision-worker.js");
await access(launcher);
await access(cli);
await access(storageWorker);
const forbiddenNativeResources = ["app.asar", "electron", "Electron"];
const bundleEntries = await walk(appRoot);
const forbidden = bundleEntries.filter((path) => forbiddenNativeResources.some((name) => path.toLowerCase().includes(name.toLowerCase())));
if (forbidden.length) throw new Error(`Native bundle contains Electron resources: ${forbidden.join("\n")}`);
if (bundleEntries.some((path) => path.endsWith("/ufo-browser-native") || path.endsWith("/ufo-cef-host"))) {
  throw new Error("Native bundle still contains a separate launcher or CEF host executable");
}

const userData = await mkdtemp(join(tmpdir(), "ufo-native-bundle-smoke-"));
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
let appStderr = "";
app.stderr.setEncoding("utf8");
app.stderr.on("data", (chunk) => { appStderr += chunk; });
const socket = join(userData, "ufo-browser.sock");
try {
  await waitForFile(socket, app, 20_000);
  const agent = spawn(cli, ["nodejs"], {
    cwd: root,
    env: { ...process.env, UFO_BROWSER_SOCKET: socket },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  agent.stdout.setEncoding("utf8");
  agent.stderr.setEncoding("utf8");
  agent.stdout.on("data", (chunk) => { stdout += chunk; });
  agent.stderr.on("data", (chunk) => { stderr += chunk; });
  agent.stdin.end(
    "const task = await bootstrapTaskSpace({ name: 'native bundle smoke', url: 'https://example.com/' })\n" +
    "cliLog((await pageInfo()).title)\n" +
    "cliLog(await captureScreenshot())\n" +
    "await completeTaskSpace(task.id, { keep: false })\n",
  );
  const exitCode = await waitForExit(agent, 30_000);
  if (exitCode !== 0 || !stdout.includes("Example Domain") || !stdout.includes("ego-browser-shot-")) {
    throw new Error(`Native bundle CLI failed (${exitCode})\n${stdout}\n${stderr}\n${appStderr}`);
  }
  console.log(JSON.stringify({ appRoot, socket, oneUfoMainProcess: true, agent: true, screenshot: true }));
} finally {
  if (app.exitCode === null) app.kill("SIGTERM");
  await waitForExit(app, 5_000).catch(() => undefined);
  await rm(userData, { recursive: true, force: true });
}

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else files.push(child);
  }
  return files;
}

async function waitForFile(path, process, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Native bundle exited (${process.exitCode})\n${appStderr}`);
    try { await access(path); return; } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Native bundle socket did not start: ${path}\n${appStderr}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("process exit timed out")), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolveExit(code ?? 1); });
  });
}
