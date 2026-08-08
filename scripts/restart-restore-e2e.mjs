import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const testNamespace = "restart-restore";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
const userData = join(testRoot, "user-data");
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
const electron = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

let revision = "one";
const requests = [];
const server = http.createServer((request, response) => {
  if (request.url === "/restored") {
    requests.push({ revision, at: Date.now() });
  }
  const color = revision === "one" ? "rgb(213, 48, 78)" : "rgb(31, 112, 224)";
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Revision ${revision}</title>` +
      `<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:${color};color:white;font:700 64px system-ui}</style>` +
      `<main>Revision ${revision}</main>`,
  );
});

await stopTestApp();
await rm(testRoot, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server failed");
const restoredUrl = `http://127.0.0.1:${address.port}/restored`;
const now = Date.now();
await writeFile(
  join(userData, "browser-state.json"),
  `${JSON.stringify(
    {
      version: 1,
      nextSpaceId: 2,
      spaces: [
        {
          id: 1,
          taskId: "Restart Restore",
          name: "Restart Restore",
          createdBy: "user",
          ownership: "user",
          lifecycle: "active",
          profileId: "default",
          tabs: [
            {
              targetId: "restart-restored-page",
              url: restoredUrl,
              title: "Persisted page",
              createdAt: now,
            },
          ],
          activeTabId: "restart-restored-page",
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

let child;
let stderr = "";
try {
  const first = await launchAndObserve("one");
  revision = "two";
  const requestCountBeforeRestart = requests.length;
  const second = await launchAndObserve("two");

  assert.ok(
    requests.slice(requestCountBeforeRestart).some((request) => request.revision === "two"),
    "relaunch did not request the persisted real URL before a Space click",
  );
  assert.notEqual(
    first.preview.renderer.canvases[0]?.signature,
    second.preview.renderer.canvases[0]?.signature,
    "relaunch reused a stale Overview preview instead of the new page revision",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        requests,
        first: summarize(first),
        second: summarize(second),
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  await stopChild();
  server.close();
  await stopTestApp().catch(() => undefined);
}

async function launchAndObserve(expectedRevision) {
  await Promise.all([
    rm(join(testRoot, "preview-main-live.json"), { force: true }),
    rm(join(testRoot, "preview-state.json"), { force: true }),
    rm(join(testRoot, "overview.png"), { force: true }),
  ]);
  const launchedAt = Date.now();
  stderr = "";
  child = spawn(electron, ["."], {
    cwd: root,
    env: {
      ...process.env,
      X_BROWSER_TEST_APP: "1",
      X_BROWSER_TEST_FAIL_COLD_PREVIEW: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
  });

  const diagnostics = await waitForJson(
    "preview-main-live.json",
    launchedAt,
    (state) => {
      const runtime = state.runtimes?.find(
        (candidate) => candidate.targetId === "restart-restored-page",
      );
      return (
        state.app?.presentation?.kind === "overview" &&
        runtime?.runtime === true &&
        runtime?.loaded === true &&
        runtime?.retained === false &&
        runtime?.title === `Revision ${expectedRevision}` &&
        runtime?.backgroundSurface === false &&
        state.parkedRestoreTargets?.includes("restart-restored-page") &&
        state.backgroundSurfaceWindowVisible === false &&
        (state.captures?.length ?? 0) === 0 &&
        (state.coldCaptures?.length ?? 0) === 0
      );
    },
    10_000,
  );
  const preview = await waitForJson(
    "preview-state.json",
    launchedAt,
    (state) =>
      state.renderer?.canvases?.[0]?.ready === true &&
      Boolean(state.renderer.canvases[0].signature),
    10_000,
  );
  assert.ok(
    requests.some((request) => request.revision === expectedRevision),
    `launch did not request revision ${expectedRevision}`,
  );
  await stopChild();
  return { diagnostics, preview };
}

function summarize(result) {
  const runtime = result.diagnostics.runtimes.find(
    (candidate) => candidate.targetId === "restart-restored-page",
  );
  return {
    signature: result.preview.renderer.canvases[0]?.signature,
    title: runtime?.title,
    runtime: runtime?.runtime,
    loaded: runtime?.loaded,
    retained: runtime?.retained,
    backgroundSurface: runtime?.backgroundSurface,
    parkedRestoreTargets: result.diagnostics.parkedRestoreTargets,
    backgroundSurfaceWindowVisible:
      result.diagnostics.backgroundSurfaceWindowVisible,
  };
}

async function waitForJson(name, launchedAt, predicate, timeoutMs) {
  const path = join(testRoot, name);
  const deadline = Date.now() + timeoutMs;
  let latest;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs >= launchedAt) {
        latest = JSON.parse(await readFile(path, "utf8"));
        if (predicate(latest)) return latest;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(
    `timed out waiting for ${name}: ${String(lastError || JSON.stringify(latest))}`,
  );
}

async function stopChild() {
  if (!child) return;
  const running = child;
  child = undefined;
  running.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => running.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await stopTestApp().catch(() => undefined);
}

async function stopTestApp() {
  return execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")]);
}
