import assert from "node:assert/strict";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

const root = resolve(new URL("..", import.meta.url).pathname);
const userData = await mkdtemp(join(tmpdir(), "ufo-native-chrome-shell-"));
const controlSocket = `/tmp/ufo-chrome-${process.pid}-${Date.now()}.sock`;
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
await access(executable);
const child = spawn(executable, ["--url=https://example.com/", `--user-data-dir=${userData}`, `--control-socket=${controlSocket}`, "--chrome-shell", "--show-on-start"], {
  cwd: root,
  stdio: ["ignore", "ignore", "pipe"],
  detached: true,
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
try {
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        clearTimeout(timer);
        resolveReady();
      } else rejectReady(new Error(`CEF shell did not start\n${stderr}`));
    }, 3_000);
    child.once("error", rejectReady);
    child.once("exit", (code) => rejectReady(new Error(`CEF shell exited ${code}\n${stderr}`)));
  });
  const source = await readSource(join(root, "native/cef-host/app.cc"));
  assert.match(source, /CEF_CTT_NORMAL/);
  assert.match(source, /return CEF_RUNTIME_STYLE_CHROME;/);
  assert.match(source, /HasSwitch\("chrome-shell"\)/);
  assert.match(source, /GetChromeToolbar\(\)/);
  assert.match(source, /AddChildViewAt\(toolbar, 0\)/);
  let status;
  const statusDeadline = Date.now() + 5_000;
  while (Date.now() < statusDeadline) {
    try {
      status = JSON.parse(await sendSocket(controlSocket, JSON.stringify({ command: "presentation-status" })));
      if (status.mainChromeToolbarAttached) break;
    } catch {
      // The native control socket and first toolbar layout become ready
      // asynchronously during cold start.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.equal(status?.mainChromeToolbarAttached, true, `native toolbar was not visibly laid out: ${JSON.stringify(status)}`);
  console.log(JSON.stringify({ chromeRuntime: true, nativeToolbar: true, visibleNativeToolbar: true, explicitChromeShell: true }));
} finally {
  if (child.exitCode === null) signalProcessGroup(child, "SIGTERM");
  const exit = await waitForExit(child, 5_000);
  if (exit.timedOut) {
    signalProcessGroup(child, "SIGKILL");
    await waitForExit(child, 1_000);
    throw new Error(`CEF shell did not terminate after SIGTERM\n${stderr}`);
  }
  const canonical = await realpath(userData);
  const processDeadline = Date.now() + 3_000;
  let leaked = [];
  while (Date.now() < processDeadline) {
    const processes = await listProcesses();
    leaked = processes.filter((line) =>
      (line.includes(userData) || line.includes(canonical)) && /ufo-cef-host/.test(line),
    );
    if (leaked.length === 0) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  await rm(controlSocket, { force: true });
  await rm(userData, { recursive: true, force: true });
  if (leaked.length) {
    throw new Error(`CEF shell left helper processes alive:\n${leaked.join("\n")}`);
  }
}

function sendSocket(path, command) {
  return new Promise((resolveStatus, rejectStatus) => {
    const socket = createConnection(path);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", rejectStatus);
    socket.once("close", () => resolveStatus(response.trim()));
    socket.once("connect", () => socket.write(`${command}\n`));
  });
}

function signalProcessGroup(child, signal) {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through if the group already exited.
    }
  }
  child.kill(signal);
}

function waitForExit(process, timeoutMs) {
  if (process.exitCode !== null) return Promise.resolve({ code: process.exitCode, signal: null, timedOut: false });
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => resolveExit({ code: null, signal: null, timedOut: true }), timeoutMs);
    process.once("error", (error) => { clearTimeout(timer); rejectExit(error); });
    process.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal, timedOut: false });
    });
  });
}

function listProcesses() {
  return new Promise((resolveProcesses, rejectProcesses) => {
    const process = spawn("/bin/ps", ["-axo", "command"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk) => { output += chunk; });
    process.once("error", rejectProcesses);
    process.once("exit", (code) => code === 0
      ? resolveProcesses(output.split("\n"))
      : rejectProcesses(new Error(`ps failed (${code})`)));
  });
}

async function readSource(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
