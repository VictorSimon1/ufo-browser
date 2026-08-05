import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const testNamespace = "live-preview";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.X_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
const electron = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const cli = join(root, "dist/bin/x-browser");
let child;
let taskId;
let completed = false;
let stderr = "";

try {
  await stopTestApp();
  child = launchApp();
  await waitForTestSocket(Date.now(), 20_000);
  const created = JSON.parse(
    await runCli(`
const task = await useOrCreateTaskSpace('x-browser live preview e2e ' + Date.now())
const html = \`<!doctype html><meta charset="utf-8"><title>Live Preview E2E</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:hsl(205 72% 90%);transition:background .1s linear}.value{font:800 96px/1 -apple-system;color:#173a32}</style><div class="value">0</div><script>let n=0;setInterval(()=>{n++;document.querySelector('.value').textContent=String(n);document.body.style.background='hsl('+((205+n*13)%360)+' 72% 90%)'},180)</script>\`
await openOrReuseTab('data:text/html;charset=utf-8,' + encodeURIComponent(html), { wait: true, timeout: 20 })
cliLog(JSON.stringify({ taskId: task.id }))
`),
  );
  taskId = Number(created.taskId);
  if (!Number.isSafeInteger(taskId)) throw new Error("live preview task id missing");

  await stopTestApp();
  child?.kill("SIGTERM");
  const launchedAt = Date.now();
  child = launchApp({
    X_BROWSER_TEST_SPACE_ID: String(taskId),
    X_BROWSER_TEST_OVERVIEW_SPACE_ID: String(taskId),
    X_BROWSER_TEST_RETURN_OVERVIEW: "1",
  });
  await waitForTestSocket(launchedAt, 20_000);

  const presented = await waitForDiagnostics(
    launchedAt,
    (state) =>
      state.active === false &&
      state.runtimes?.some(
        (runtime) => runtime.spaceId === taskId && runtime.presented === true,
      ),
    3_000,
  );
  const presentedRuntime = presented.runtimes.find(
    (runtime) => runtime.spaceId === taskId && runtime.presented === true,
  );

  const first = await waitForDiagnostics(
    launchedAt,
    (state) =>
      state.visibleSpaceIds?.includes(taskId) &&
      state.screencast?.spaceId === taskId &&
      state.screencast.publishedFrames >= 1,
    12_000,
  );
  const firstFrames = Number(first.screencast.publishedFrames);
  const firstRevision = Number(first.publishedRevision?.[String(taskId)] || 0);
  const firstRendererState = await freshJson("preview-state.json", launchedAt, 6_000);
  const firstCanvas = firstRendererState.renderer?.canvases?.find(
    (canvas) => Number(canvas.spaceId) === taskId,
  );
  const returnedRuntime = first.runtimes.find(
    (runtime) => runtime.spaceId === taskId && runtime.activeTab === true,
  );
  if (
    !presentedRuntime?.presented ||
    Number(presentedRuntime.webContentsId) <= 0 ||
    presentedRuntime.webContentsId !== returnedRuntime?.webContentsId
  ) {
    throw new Error("live preview did not preserve the opened Space runtime");
  }
  const progressed = await waitForDiagnostics(
    launchedAt,
    (state) =>
      state.screencast?.spaceId === taskId &&
      state.screencast.publishedFrames >= firstFrames + 3 &&
      Number(state.publishedRevision?.[String(taskId)] || 0) > firstRevision,
    8_000,
  );
  const finalRendererState = await freshJson(
    "preview-state-settled.json",
    launchedAt,
    14_000,
  );
  const finalCanvas = finalRendererState.renderer?.canvases?.find(
    (canvas) => Number(canvas.spaceId) === taskId,
  );
  if (!firstCanvas?.ready || !finalCanvas?.ready) {
    throw new Error("dynamic Overview canvas never became ready");
  }
  if (!firstCanvas.signature || firstCanvas.signature === finalCanvas.signature) {
    throw new Error(
      `dynamic Overview canvas pixels did not change: ${JSON.stringify({ firstCanvas, finalCanvas })}`,
    );
  }
  const previewRatio = Number(finalCanvas.cssWidth) / Number(finalCanvas.cssHeight);
  if (!(previewRatio > 1.47 && previewRatio < 1.53)) {
    throw new Error(`Overview preview is not the expected 3:2 shape: ${previewRatio}`);
  }

  const page = JSON.parse(
    await runCli(`
const task = await useOrCreateTaskSpace(${taskId})
cliLog(JSON.stringify({ value: Number(await js("document.querySelector('.value').textContent")), page: await pageInfo() }))
`),
  );
  if (!(page.value > 0)) throw new Error("dynamic page did not advance");

  await runCli(`
cliLog(JSON.stringify(await completeTaskSpace(${taskId}, { keep: false })))
`);
  completed = true;
  const cleaned = await waitForDiagnostics(
    launchedAt,
    (state) =>
      state.screencast == null &&
      !state.runtimes?.some(
        (runtime) => runtime.spaceId === taskId && runtime.runtime,
      ) &&
      !state.runtimes?.some(
        (runtime) => runtime.spaceId === taskId && runtime.backgroundSurface,
      ),
    8_000,
  );

  console.log(
    JSON.stringify(
      {
        taskId,
        firstFrames,
        finalFrames: progressed.screencast.publishedFrames,
        firstRevision,
        finalRevision: progressed.publishedRevision[String(taskId)],
        firstCanvasSignature: firstCanvas.signature,
        finalCanvasSignature: finalCanvas.signature,
        canvasPixelsChanged: firstCanvas.signature !== finalCanvas.signature,
        previewRatio,
        pageValue: page.value,
        openedBeforeOverview: Boolean(presentedRuntime?.presented),
        roundTripWebContentsStable:
          Number(presentedRuntime?.webContentsId) > 0 &&
          presentedRuntime.webContentsId === returnedRuntime?.webContentsId,
        cleaned: cleaned.screencast == null,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  if (taskId && !completed) {
    await runCli(`
cliLog(JSON.stringify(await completeTaskSpace(${taskId}, { keep: false })))
`).catch(() => undefined);
  }
  child?.kill("SIGTERM");
  await stopTestApp().catch(() => undefined);
}

function launchApp(extraEnv = {}) {
  stderr = "";
  const process = spawn(electron, ["."], {
    cwd: root,
    env: { ...globalThis.process.env, X_BROWSER_TEST_APP: "1", ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  process.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
  });
  return process;
}

function runCli(code) {
  return new Promise((resolve, reject) => {
    const process = spawn(cli, ["nodejs"], {
      cwd: root,
      env: globalThis.process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let cliStderr = "";
    process.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    process.stderr.on("data", (chunk) => (cliStderr += chunk.toString()));
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(cliStderr || `x-browser exited ${code}`));
    });
    process.stdin.end(code);
  });
}

async function waitForDiagnostics(launchedAt, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      const path = join(testRoot, "preview-main-live.json");
      const metadata = await stat(path);
      if (metadata.mtimeMs >= launchedAt - 250) {
        latest = JSON.parse(await readFile(path, "utf8"));
        if (predicate(latest)) return latest;
      }
    } catch {
      // The diagnostics file appears shortly after App startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`live preview diagnostics timed out: ${JSON.stringify(latest)}`);
}

async function waitForTestSocket(launchedAt, timeoutMs) {
  const marker = join(testRoot, "socket-path");
  const deadline = Date.now() + timeoutMs;
  let latestError;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(marker);
      if (metadata.mtimeMs < launchedAt - 250) throw new Error("stale socket marker");
      const socketPath = (await readFile(marker, "utf8")).trim();
      await new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.once("connect", () => {
          socket.end();
          resolve(undefined);
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      latestError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timed out waiting for X-Browser socket: ${latestError}`);
}

async function freshJson(name, launchedAt, timeoutMs) {
  const path = join(testRoot, name);
  const deadline = Date.now() + timeoutMs;
  let latestError;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs < launchedAt - 250) throw new Error("stale diagnostics");
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      latestError = error;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  throw new Error(`timed out waiting for ${name}: ${latestError}`);
}

function stopTestApp() {
  return execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")]);
}
