import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const executable =
  process.env.X_BROWSER_TEST_EXECUTABLE ||
  join(
    root,
    "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
const runs = [];

for (let attempt = 1; attempt <= 3; attempt++) {
  const namespace = `app-quit-${attempt}`;
  const testRoot = join(root, ".x-browser-test", "runs", namespace);
  await execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")], {
    env: {
      ...process.env,
      X_BROWSER_TEST_NAMESPACE: namespace,
      UFO_BROWSER_SOCKET: join(testRoot, "x-browser.sock"),
    },
  }).catch(() => undefined);
  await rm(testRoot, { recursive: true, force: true });
  const launchedAt = Date.now();
  const child = spawn(
    executable,
    process.env.X_BROWSER_TEST_EXECUTABLE ? [] : ["."],
    {
      cwd: root,
      env: {
        ...process.env,
        X_BROWSER_TEST_APP: "1",
        X_BROWSER_TEST_APP_QUIT_AUDIT: "1",
        X_BROWSER_TEST_NAMESPACE: namespace,
        X_BROWSER_TEST_ROOT: testRoot,
        UFO_BROWSER_SOCKET: join(testRoot, "x-browser.sock"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-24_000);
  });

  try {
    const audit = await freshJson(
      join(testRoot, "app-quit-audit.json"),
      launchedAt,
      15_000,
    );
    assert.equal(audit.ok, true, JSON.stringify(audit));
    assert.equal(audit.armed, true);
    const exit = await childExit(child, 15_000);
    if (exit.code !== 0 || exit.signal) {
      if (stderr) process.stderr.write(stderr);
    }
    assert.deepEqual(exit, { code: 0, signal: null });
    runs.push({ attempt, ...audit, exit });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

process.stdout.write(`${JSON.stringify({ ok: true, runs }, null, 2)}\n`);

async function freshJson(path, launchedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs >= launchedAt - 250) {
        return JSON.parse(await readFile(path, "utf8"));
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timed out waiting for ${path}: ${lastError || "not written"}`);
}

function childExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("UFO-Browser did not exit after app.quit()"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
