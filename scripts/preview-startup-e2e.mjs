import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const testNamespace = "preview-startup";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.X_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
const electron = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const launchedAt = Date.now();

await execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")]);
// This verifier measures a genuinely fresh browser profile. Reusing the
// namespace would restore whatever URL an older run persisted (historically
// Google), turning the local-new-tab startup assertion into a network test.
await rm(testRoot, { recursive: true, force: true });
const child = spawn(electron, ["."], {
  cwd: root,
  env: { ...process.env, X_BROWSER_TEST_APP: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
});

try {
  const initial = await freshJson("preview-main-initial.json", 7_000);
  const state = await freshJson("preview-state.json", 9_000);
  const ready = state.renderer?.canvases?.filter((canvas) => canvas.ready).length ?? 0;
  const diagnostics = state.main || {};
  const minimumFrames = Math.min(2, diagnostics.visibleSpaceIds?.length ?? 0);
  const minimumReady = Math.min(2, diagnostics.visibleSpaceIds?.length ?? 0);
  const result = {
    initialVisible: initial.visibleSpaceIds?.length ?? 0,
    visible: diagnostics.visibleSpaceIds?.length ?? 0,
    ready,
    receivedFrames: state.renderer?.receivedFrames ?? 0,
    captures: diagnostics.captures?.length ?? 0,
    coldCaptures: diagnostics.coldCaptures?.length ?? 0,
    previewError: state.renderer?.previewError ?? null,
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    result.initialVisible < 1 ||
    result.visible < 1 ||
    result.visible > 8 ||
    result.ready < minimumReady ||
    result.receivedFrames < minimumFrames ||
    result.captures > 2 ||
    result.coldCaptures > 1 ||
    result.previewError
  ) {
    throw new Error("cold-start preview did not hydrate within the bounded startup window");
  }
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
  throw new Error(`timed out waiting for fresh ${name}: ${lastError || "not written"}`);
}
