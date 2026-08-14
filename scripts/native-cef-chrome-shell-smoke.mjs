import assert from "node:assert/strict";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const userData = await mkdtemp(join(tmpdir(), "ufo-native-chrome-shell-"));
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
await access(executable);
const child = spawn(executable, ["--url=https://example.com/", `--user-data-dir=${userData}`, "--chrome-shell", "--show-on-start"], {
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
  assert.match(await readSource(join(root, "native/cef-host/app.cc")), /CEF_CTT_NORMAL/);
  assert.match(await readSource(join(root, "native/cef-host/app.cc")), /return CEF_RUNTIME_STYLE_CHROME;/);
  assert.match(await readSource(join(root, "native/cef-host/app.cc")), /HasSwitch\("chrome-shell"\)/);
  console.log(JSON.stringify({ chromeRuntime: true, nativeToolbar: true, explicitChromeShell: true }));
} finally {
  if (child.exitCode === null) signalProcessGroup(child, "SIGTERM");
  const exit = await waitForExit(child, 5_000);
  if (exit.timedOut) {
    signalProcessGroup(child, "SIGKILL");
    await waitForExit(child, 1_000);
    throw new Error(`CEF shell did not terminate after SIGTERM\n${stderr}`);
  }
  const canonical = await realpath(userData);
  const processes = await listProcesses();
  const leaked = processes.filter((line) =>
    (line.includes(userData) || line.includes(canonical)) && /ufo-cef-host/.test(line),
  );
  if (leaked.length) {
    throw new Error(`CEF shell left helper processes alive:\n${leaked.join("\n")}`);
  }
  await rm(userData, { recursive: true, force: true });
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
