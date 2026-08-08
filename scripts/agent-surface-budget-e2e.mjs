import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const testNamespace = "agent-surface-budget";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
const userData = join(testRoot, "user-data");
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
const electron = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const cli = join(root, "dist/bin/ufo-browser");
const launchedAt = Date.now();
let child;
let stderr = "";

try {
  await stopTestApp();
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(userData, { recursive: true });
  await writeFile(
    join(userData, "browser-state.json"),
    `${JSON.stringify(seedState(), null, 2)}\n`,
    { mode: 0o600 },
  );
  child = spawn(electron, ["."], {
    cwd: root,
    env: {
      ...process.env,
      X_BROWSER_TEST_APP: "1",
      X_BROWSER_TEST_SPACE_ID: "2",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
  });
  await waitForTestSocket(20_000);

  const dynamicPage = `<!doctype html><meta charset="utf-8"><title>Surface Budget</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#edf4f1}.pulse{width:120px;height:120px;border-radius:50%;background:#397968;animation:pulse .6s ease-in-out infinite alternate}@keyframes pulse{to{transform:scale(1.12);opacity:.68}}</style><div class="pulse"></div><output>0</output><script>globalThis.surfaceTicks=0;setInterval(()=>{surfaceTicks+=1;document.querySelector('output').textContent=String(surfaceTicks)},50)</script>`;
  const firstRun = runCli(`
const task = await useOrCreateTaskSpace(1)
await openOrReuseTab('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(dynamicPage)}), { wait: true, timeout: 20 })
await wait(4.4)
cliLog(JSON.stringify({ taskId: task.id, ticks: await js('globalThis.surfaceTicks'), page: await pageInfo() }))
`);

  const active = await waitForDiagnostics(
    (state) => {
      const runtime = state.runtimes?.find(
        (candidate) => candidate.spaceId === 1 && candidate.runtime,
      );
      return (
        state.activeAgentConnections?.includes(1) &&
        state.backgroundSurfaceWindowVisible === true &&
        runtime?.backgroundSurface === true
      );
    },
    10_000,
  );
  const activeGpuSamples = await collectGpuSamples(2_000);
  const first = JSON.parse(await firstRun);
  assert.equal(first.taskId, 1);
  assert.ok(first.ticks > 0);
  assert.ok(first.page.w > 0 && first.page.h > 0);

  const parked = await waitForDiagnostics(
    (state) => {
      const runtime = state.runtimes?.find(
        (candidate) => candidate.spaceId === 1 && candidate.runtime,
      );
      return (
        !state.activeAgentConnections?.includes(1) &&
        state.backgroundSurfaceWindowVisible === false &&
        runtime?.retained === true &&
        runtime?.backgroundSurface === false
      );
    },
    5_000,
  );
  // AppKit/Viz can report the native surface as hidden before the final Metal
  // command buffers retire. Measure the steady state, not that bounded drain.
  await new Promise((resolve) => setTimeout(resolve, 900));
  const parkedGpuSamples = await collectGpuSamples(3_000);
  const activeGpuMedian = median(activeGpuSamples);
  const parkedGpuMedian = median(parkedGpuSamples);
  assert.ok(activeGpuSamples.length >= 4 && parkedGpuSamples.length >= 4);
  assert.ok(
    parkedGpuMedian <= Math.max(2.5, activeGpuMedian * 0.35),
    `parked GPU did not quiesce: ${JSON.stringify({ activeGpuMedian, parkedGpuMedian })}`,
  );

  await new Promise((resolve) => setTimeout(resolve, 450));
  const resumed = JSON.parse(
    await runCli(`
const task = await useOrCreateTaskSpace(1)
await wait(0.25)
cliLog(JSON.stringify({ taskId: task.id, ticks: await js('globalThis.surfaceTicks'), page: await pageInfo() }))
`),
  );
  assert.equal(resumed.taskId, 1);
  assert.ok(resumed.ticks > first.ticks, "detached runtime lost its live JS state");
  assert.ok(resumed.page.w > 0 && resumed.page.h > 0);

  const reparked = await waitForDiagnostics(
    (state) => {
      const runtime = state.runtimes?.find(
        (candidate) => candidate.spaceId === 1 && candidate.runtime,
      );
      return (
        !state.activeAgentConnections?.includes(1) &&
        state.backgroundSurfaceWindowVisible === false &&
        runtime?.backgroundSurface === false
      );
    },
    5_000,
  );

  const handoffRun = runCli(`
const task = await useOrCreateTaskSpace(1)
const handoff = await handOffTaskSpace(task.id)
cliLog(JSON.stringify({ taskId: task.id, handoff }))
await new Promise(resolve => setTimeout(resolve, 1400))
`);
  const revoked = await waitForDiagnostics(
    (state) => {
      const runtime = state.runtimes?.find(
        (candidate) => candidate.spaceId === 1 && candidate.runtime,
      );
      return (
        runtime?.ownership === "agentDelegatedToUser" &&
        !state.activeAgentConnections?.includes(1) &&
        state.backgroundSurfaceWindowVisible === false &&
        runtime?.backgroundSurface === false
      );
    },
    5_000,
  );
  const handedOff = JSON.parse(await handoffRun);
  assert.deepEqual(handedOff.handoff, { done: true });

  await runCli(`
cliLog(JSON.stringify(await completeTaskSpace(1, { keep: false })))
`);

  const directlyClosed = JSON.parse(
    await runCli(`
const task = await useOrCreateTaskSpace('direct surface close ' + Date.now())
const html = '<!doctype html><title>Direct Surface Close</title><style>html,body{height:100%;margin:0;background:#eef5f2}</style>'
await openOrReuseTab('data:text/html;charset=utf-8,' + encodeURIComponent(html), { wait: true, timeout: 20 })
const completed = await completeTaskSpace(task.id, { keep: false })
cliLog(JSON.stringify({ taskId: task.id, completed }))
`),
  );
  assert.deepEqual(directlyClosed.completed, { done: true });
  const directlyClosedSurface = await waitForDiagnostics(
    (state) =>
      !state.runtimes?.some(
        (candidate) => candidate.spaceId === directlyClosed.taskId,
      ) &&
      state.backgroundSurfaceWindowVisible === false &&
      state.app?.backgroundSurfaceWindow?.childCount === 0,
    5_000,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        active: {
          connections: active.activeAgentConnections,
          surfaceWindowVisible: active.backgroundSurfaceWindowVisible,
        },
        parked: {
          connections: parked.activeAgentConnections,
          surfaceWindowVisible: parked.backgroundSurfaceWindowVisible,
          runtimeRetained: parked.runtimes.find(
            (candidate) => candidate.spaceId === 1,
          )?.retained,
        },
        firstTicks: first.ticks,
        resumedTicks: resumed.ticks,
        gpuPercent: {
          activeSamples: activeGpuSamples,
          parkedSamples: parkedGpuSamples,
          activeMedian: activeGpuMedian,
          parkedMedian: parkedGpuMedian,
        },
        reparkedSurfaceWindowVisible:
          reparked.backgroundSurfaceWindowVisible,
        ownershipRevocation: {
          ownership: revoked.runtimes.find(
            (candidate) => candidate.spaceId === 1,
          )?.ownership,
          connections: revoked.activeAgentConnections,
          surfaceWindowVisible: revoked.backgroundSurfaceWindowVisible,
        },
        directCloseCleanup: {
          taskId: directlyClosed.taskId,
          surfaceWindowVisible:
            directlyClosedSurface.backgroundSurfaceWindowVisible,
          childCount:
            directlyClosedSurface.app.backgroundSurfaceWindow.childCount,
        },
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  child?.kill("SIGTERM");
  await stopTestApp().catch(() => undefined);
}

function seedState() {
  const now = Date.now();
  return {
    version: 1,
    nextSpaceId: 3,
    spaces: [
      {
        id: 1,
        taskId: "Agent Surface Budget",
        name: "Agent Surface Budget",
        createdBy: "agent",
        ownership: "agent",
        lifecycle: "active",
        profileId: "default",
        tabs: [
          {
            targetId: "agent-surface-page",
            url: "x-browser://newtab/",
            title: "New Tab",
            createdAt: now,
          },
        ],
        activeTabId: "agent-surface-page",
        agentTask: {
          title: "Agent Surface Budget",
          detail: "GPU lifecycle audit",
          completed: 0,
          total: 1,
          updatedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 2,
        taskId: "Visible User Space",
        name: "Visible User Space",
        createdBy: "user",
        ownership: "user",
        lifecycle: "active",
        profileId: "default",
        tabs: [
          {
            targetId: "visible-user-page",
            url: "x-browser://newtab/",
            title: "New Tab",
            createdAt: now + 1,
          },
        ],
        activeTabId: "visible-user-page",
        createdAt: now + 1,
        updatedAt: now + 1,
      },
    ],
  };
}

async function stopTestApp() {
  return execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")]);
}

async function waitForTestSocket(timeoutMs) {
  const marker = join(testRoot, "socket-path");
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(marker);
      if (metadata.mtimeMs >= launchedAt - 250) {
        const socketPath = (await readFile(marker, "utf8")).trim();
        await connectOnce(socketPath);
        return;
      }
    } catch (error) {
      lastError = error;
      // Written after the Agent server is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`test App socket did not become ready: ${String(lastError)}`);
}

function connectOnce(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
  });
}

async function waitForDiagnostics(predicate, timeoutMs) {
  const path = join(testRoot, "preview-main-live.json");
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs >= launchedAt - 250) {
        latest = JSON.parse(await readFile(path, "utf8"));
        if (predicate(latest)) return latest;
      }
    } catch {
      // The diagnostics writer may be between truncate and write.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`surface diagnostics timed out: ${JSON.stringify(latest)}`);
}

async function collectGpuSamples(durationMs) {
  const path = join(testRoot, "preview-main-live.json");
  const deadline = Date.now() + durationMs;
  let lastMtime = 0;
  const samples = [];
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs > lastMtime) {
        lastMtime = metadata.mtimeMs;
        const state = JSON.parse(await readFile(path, "utf8"));
        const gpu = state.processMetrics?.find((metric) => metric.type === "GPU");
        const percent = Number(gpu?.cpu?.percentCPUUsage);
        if (Number.isFinite(percent)) samples.push(percent);
      }
    } catch {
      // The diagnostics writer may be between truncate and write.
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return samples;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function runCli(source) {
  return new Promise((resolve, reject) => {
    const process = spawn(cli, ["nodejs"], {
      cwd: root,
      env: globalThis.process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let cliStderr = "";
    process.stdout.on("data", (chunk) => (stdout += String(chunk)));
    process.stderr.on("data", (chunk) => (cliStderr += String(chunk)));
    process.once("error", reject);
    process.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(cliStderr || `ufo-browser exited ${code}`));
    });
    process.stdin.end(source);
  });
}
