import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const testNamespace = "space-ui";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.X_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
const electron = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const launchedAt = Date.now();
let child;
let stderr = "";

try {
  await stopTestApp();
  child = spawn(electron, ["."], {
    cwd: root,
    env: {
      ...process.env,
      X_BROWSER_TEST_APP: "1",
      X_BROWSER_TEST_SPACE_UI_AUDIT: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
  });
  const audit = await freshJson("space-ui-audit.json", 12_000);
  assert.equal(audit.ok, true, JSON.stringify(audit));
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  child?.kill("SIGTERM");
  await stopTestApp().catch(() => undefined);
}

async function stopTestApp() {
  return execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")]);
}

async function freshJson(name, timeoutMs) {
  const path = join(testRoot, name);
  const deadline = Date.now() + timeoutMs;
  let latestError;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs >= launchedAt - 250) {
        return JSON.parse(await readFile(path, "utf8"));
      }
    } catch (error) {
      latestError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timed out waiting for ${name}: ${latestError || "not written"}`);
}
