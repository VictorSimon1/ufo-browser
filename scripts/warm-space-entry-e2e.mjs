import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const testNamespace = "warm-space-entry";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
const userData = join(testRoot, "user-data");
const roundTripCount = Math.max(
  1,
  Number.parseInt(process.env.UFO_WARM_ENTRY_ROUND_TRIPS || "12", 10) || 12,
);
const idleEvery = Math.max(
  1,
  Number.parseInt(process.env.UFO_WARM_ENTRY_IDLE_EVERY || "3", 10) || 3,
);
const idleMs = Math.max(
  0,
  Number.parseInt(process.env.UFO_WARM_ENTRY_IDLE_MS || "1500", 10) || 0,
);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
process.env.UFO_WARM_ENTRY_ROUND_TRIPS = String(roundTripCount);
process.env.UFO_WARM_ENTRY_IDLE_EVERY = String(idleEvery);
process.env.UFO_WARM_ENTRY_IDLE_MS = String(idleMs);
const electron = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

const requests = [];
const server = http.createServer((request, response) => {
  const match = /^\/space\/(\d+)$/.exec(request.url || "");
  if (!match) {
    response.writeHead(204);
    response.end();
    return;
  }
  const spaceId = Number(match[1]);
  const loadId = `space-${spaceId}-${Date.now()}`;
  requests.push({ spaceId, loadId, at: Date.now() });
  setTimeout(() => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Warm Space ${spaceId}</title>` +
        `<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:hsl(${spaceId * 76} 55% 48%);color:white;font:700 64px system-ui}</style>` +
        `<main data-load-id="${loadId}">Warm Space ${spaceId} <span>0</span></main>` +
        `<script>let n=0;setInterval(()=>{n++;document.querySelector('span').textContent=String(n);document.body.style.background='hsl('+(${spaceId * 76}+n*11)%360+' 55% 48%)'},120)</script>`,
    );
  }, 700);
});

await stopTestApp();
await rm(testRoot, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server failed");
const now = Date.now();
await writeFile(
  join(userData, "browser-state.json"),
  `${JSON.stringify(
    {
      version: 1,
      nextSpaceId: 4,
      spaces: [1, 2, 3].map((id) => ({
        id,
        taskId: `Warm Space ${id}`,
        name: `Warm Space ${id}`,
        createdBy: "user",
        ownership: "user",
        lifecycle: "active",
        profileId: "default",
        tabs: [
          {
            targetId: `warm-space-${id}`,
            url: `http://127.0.0.1:${address.port}/space/${id}`,
            title: `Persisted Space ${id}`,
            createdAt: now + id,
          },
        ],
        activeTabId: `warm-space-${id}`,
        createdAt: now + id,
        updatedAt: now + id,
      })),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const launchedAt = Date.now();
const child = spawn(electron, ["."], {
  cwd: root,
  env: {
    ...process.env,
    X_BROWSER_TEST_APP: "1",
    X_BROWSER_TEST_WARM_ENTRY_AUDIT: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
  if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
});

try {
  const expectedIdleRuns = Math.floor(roundTripCount / idleEvery);
  const auditTimeoutMs = Math.max(
    30_000,
    15_000 + roundTripCount * 1_600 + expectedIdleRuns * idleMs,
  );
  const audit = await freshJson("warm-entry-audit.json", auditTimeoutMs);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const pageRequests = requests.filter((request) => request.spaceId > 0);
  const requestCounts = Object.fromEntries(
    [1, 2, 3].map((spaceId) => [
      spaceId,
      pageRequests.filter((request) => request.spaceId === spaceId).length,
    ]),
  );
  const requestTimes = pageRequests.map((request) => request.at);
  const requestSpreadMs =
    Math.max(...requestTimes) - Math.min(...requestTimes);
  assert.equal(audit.ok, true, JSON.stringify(audit));
  assert.deepEqual(requestCounts, { 1: 1, 2: 1, 3: 1 });
  assert.ok(
    requestSpreadMs < 450,
    `persisted pages did not begin restoring concurrently: ${requestSpreadMs}ms`,
  );
  assert.equal(audit.sameWebContents, true);
  assert.equal(audit.loadingAfterEntry, false);
  assert.ok(audit.entryElapsedMs < 400);
  assert.equal(audit.beforeRuntimeCount, 3);
  assert.equal(audit.beforeParkedTargets.length, 3);
  assert.equal(audit.afterParkedTargets.length, 2);
  assert.equal(audit.roundTrips.length, roundTripCount);
  assert.ok(audit.roundTrips.every((cycle) => cycle.frameVisual));
  assert.ok(
    audit.roundTrips.every((cycle) => cycle.lowFrequencyUpdated === true),
  );
  assert.ok(
    audit.roundTrips.every((cycle) => cycle.continuousPreview === false),
  );
  assert.ok(audit.roundTrips.every((cycle) => cycle.sameWebContents));
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        requestSpreadMs,
        requestCounts,
        requests: pageRequests,
        audit,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  child.kill("SIGTERM");
  server.close();
  await stopTestApp().catch(() => undefined);
}

async function stopTestApp() {
  return execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")]);
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
