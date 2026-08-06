import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const testNamespace = "browser-interaction";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
const electron = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

await execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")]);
await rm(testRoot, { recursive: true, force: true });
const launchedAt = Date.now();
const child = spawn(electron, ["."], {
  cwd: root,
  env: {
    ...process.env,
    X_BROWSER_TEST_APP: "1",
    X_BROWSER_TEST_INTERACTION_AUDIT: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
  if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
});

try {
  const audit = await freshJson("interaction-audit.json", 15_000);
  assert.equal(audit.ok, true, JSON.stringify(audit));
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  child.kill("SIGTERM");
  await execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")]).catch(
    () => undefined,
  );
}

async function freshJson(name, timeoutMs) {
  const path = join(testRoot, name);
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
  throw new Error(`timed out waiting for ${name}: ${lastError || "not written"}`);
}
