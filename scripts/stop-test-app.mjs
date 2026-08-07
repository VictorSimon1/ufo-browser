import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

try {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const testNamespace = String(process.env.X_BROWSER_TEST_NAMESPACE || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
  const requestedTestRoot = process.env.X_BROWSER_TEST_ROOT;
  const testRoot =
    requestedTestRoot && isAbsolute(requestedTestRoot)
      ? resolve(requestedTestRoot)
      : testNamespace
        ? join(root, ".x-browser-test", "runs", testNamespace)
        : join(root, ".x-browser-test");
  const configuredExecutable = process.env.X_BROWSER_TEST_EXECUTABLE;
  const executable = configuredExecutable
    ? resolve(configuredExecutable)
    : join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      );
  const expectedCommand = configuredExecutable ? executable : `${executable} .`;
  const candidates = new Set();
  const stopped = [];
  try {
    candidates.add(
      Number(readFileSync(join(testRoot, "pid"), "utf8")),
    );
  } catch {
    // A failed startup may not have written its marker yet.
  }
  for (const pid of candidates) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    let command = "";
    try {
      command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      }).trim();
    } catch {
      continue;
    }
    if (command !== expectedCommand) continue;
    execFileSync("kill", ["-TERM", String(pid)]);
    stopped.push(pid);
  }
  for (const pid of stopped) {
    await waitForExit(pid);
    if (isAlive(pid)) {
      // Electron can consume the first graceful termination while native
      // windows are closing. A second TERM finishes the same test process
      // without escalating to a destructive SIGKILL.
      execFileSync("kill", ["-TERM", String(pid)]);
      await waitForExit(pid);
    }
  }
} catch {
  // No test instance is running.
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 40 && isAlive(pid); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
