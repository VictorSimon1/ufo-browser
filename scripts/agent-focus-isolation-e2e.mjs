import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const testNamespace = "agent-focus-isolation";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
const userData = join(testRoot, "user-data");
const socketPath = join(testRoot, "x-browser.sock");
const electron = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const cli = join(root, "dist/bin/ufo-browser");
const testEnv = {
  ...process.env,
  X_BROWSER_TEST_NAMESPACE: testNamespace,
  UFO_BROWSER_SOCKET: socketPath,
};

if (process.platform !== "darwin") {
  throw new Error("Agent focus isolation E2E requires macOS");
}

const originalForeground = await systemState();
const phases = [];

try {
  phases.push(await runPhase({ presentation: "overview" }));
  phases.push(await runPhase({ presentation: "space" }));
  process.stdout.write(
    `${JSON.stringify({ ok: true, originalForeground, phases }, null, 2)}\n`,
  );
} finally {
  await stopTestApp().catch(() => undefined);
  await activateProcess(originalForeground.pid).catch(() => undefined);
}

async function runPhase({ presentation }) {
  await stopTestApp();
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(userData, { recursive: true });
  await writeFile(
    join(userData, "browser-state.json"),
    `${JSON.stringify(seedState(), null, 2)}\n`,
    { mode: 0o600 },
  );

  const launchedAt = Date.now();
  const child = spawn(electron, ["."], {
    cwd: root,
    env: {
      ...testEnv,
      X_BROWSER_TEST_APP: "1",
      ...(presentation === "space" ? { X_BROWSER_TEST_SPACE_ID: "1" } : {}),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
  });

  try {
    await waitForTestSocket(launchedAt, 20_000);
    const expectedPresentation =
      presentation === "space"
        ? (value) => value?.kind === "space" && value.spaceId === 1
        : (value) => value?.kind === "overview";
    await waitForDiagnostics(
      launchedAt,
      (state) => expectedPresentation(state.app?.presentation),
      8_000,
    );

    await activateBundle("com.apple.finder");
    const foreground = await waitForSystemState(
      (state) => state.bundleId === "com.apple.finder",
      5_000,
    );
    const before = await waitForDiagnostics(
      launchedAt,
      (state) =>
        expectedPresentation(state.app?.presentation) &&
        state.app?.mainWindow?.focused === false,
      5_000,
    );
    const cursorBefore = foreground.cursor;

    const pageHtml =
      '<!doctype html><meta charset="utf-8"><title>Agent Focus Isolation</title><style>body{font:16px system-ui;padding:40px}input,button{font:inherit;padding:10px;margin:8px}</style><input id="agent-input"><button id="agent-button">Apply</button><output id="result"></output><script>document.getElementById("agent-button").addEventListener("click",()=>{document.getElementById("result").textContent=document.getElementById("agent-input").value})</script>';
    const operation = runCli(`
const task = await useOrCreateTaskSpace(1)
const html = ${JSON.stringify(pageHtml)}
await openOrReuseTab('data:text/html;charset=utf-8,' + encodeURIComponent(html), { wait: true, timeout: 20 })
await fillInput('#agent-input', 'background-agent-input')
await click('#agent-button', { label: 'verify background click' })
const screenshot = await captureScreenshot()
const value = await js("document.querySelector('#result').textContent")
cliLog(JSON.stringify({ taskId: task.id, value, screenshot: Boolean(screenshot), page: await pageInfo() }))
await wait(1.2)
`);

    const during = await waitForDiagnostics(
      launchedAt,
      (state) => {
        const connected = state.activeAgentConnections?.includes(1);
        if (!connected || !expectedPresentation(state.app?.presentation)) return false;
        return presentation === "overview"
          ? state.app?.backgroundSurfaceWindow?.visible === true
          : state.app?.mainWindow?.rootChildren?.includes("overlay");
      },
      10_000,
    );
    const foregroundDuring = await systemState();
    assertSystemUnchanged(foreground, foregroundDuring, "during Agent operation");

    const result = JSON.parse(await operation);
    assert.equal(result.taskId, 1);
    assert.equal(result.value, "background-agent-input");
    assert.equal(result.screenshot, true);
    assert.ok(result.page.w > 0 && result.page.h > 0);

    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = await waitForDiagnostics(
      launchedAt,
      (state) =>
        expectedPresentation(state.app?.presentation) &&
        !state.activeAgentConnections?.includes(1),
      6_000,
    );
    const foregroundAfter = await systemState();
    assertSystemUnchanged(foreground, foregroundAfter, "after Agent operation");
    assert.equal(after.app.mainWindow.focused, false);
    assert.deepEqual(after.app.presentation, before.app.presentation);

    if (presentation === "overview") {
      assert.deepEqual(before.app.mainWindow.rootChildren, ["overview"]);
      assert.deepEqual(during.app.mainWindow.rootChildren, ["overview"]);
      assert.deepEqual(after.app.mainWindow.rootChildren, ["overview"]);
      assert.equal(during.presentedTargetId, null);
      assert.equal(during.app.backgroundSurfaceWindow.focused, false);
      assert.equal(during.app.backgroundSurfaceWindow.focusable, false);
      assert.equal(during.app.backgroundSurfaceWindow.opacity, 0);
      assert.equal(during.app.backgroundSurfaceWindow.hasShadow, false);
      assert.equal(during.app.backgroundSurfaceWindow.resizable, false);
      assert.equal(during.app.backgroundSurfaceWindow.minimizable, false);
      assert.equal(during.app.backgroundSurfaceWindow.maximizable, false);
      assert.equal(during.app.backgroundSurfaceWindow.fullscreenable, false);
      assert.ok(during.app.backgroundSurfaceWindow.childCount >= 1);
    } else {
      assert.ok(during.app.mainWindow.rootChildren.includes("browser"));
      assert.ok(
        during.app.mainWindow.rootChildren.some((name) => name.startsWith("page:1:")),
      );
      assert.ok(during.app.mainWindow.rootChildren.includes("overlay"));
      assert.equal(during.app.backgroundSurfaceWindow.visible, false);
      assert.equal(during.app.backgroundSurfaceWindow.focused, false);
    }

    await runCli(`
const task = await useOrCreateTaskSpace(1)
cliLog(JSON.stringify(await completeTaskSpace(task.id, { keep: true })))
`);

    return {
      presentation,
      foreground: {
        pid: foreground.pid,
        name: foreground.name,
        bundleId: foreground.bundleId,
      },
      cursor: cursorBefore,
      presentationBefore: before.app.presentation,
      presentationAfter: after.app.presentation,
      rootChildrenDuring: during.app.mainWindow.rootChildren,
      backgroundSurfaceDuring: during.app.backgroundSurfaceWindow,
      page: result.page,
    };
  } catch (error) {
    if (stderr) process.stderr.write(stderr);
    throw error;
  } finally {
    child.kill("SIGTERM");
    await stopTestApp().catch(() => undefined);
  }
}

function assertSystemUnchanged(before, after, label) {
  assert.equal(
    after.pid,
    before.pid,
    `${label}: foreground changed from ${before.name} to ${after.name}`,
  );
  assert.equal(after.bundleId, before.bundleId, `${label}: foreground bundle changed`);
  assert.ok(
    Math.abs(after.cursor.x - before.cursor.x) < 0.01 &&
      Math.abs(after.cursor.y - before.cursor.y) < 0.01,
    `${label}: cursor moved from ${JSON.stringify(before.cursor)} to ${JSON.stringify(after.cursor)}`,
  );
}

function seedState() {
  const now = Date.now();
  return {
    version: 1,
    nextSpaceId: 2,
    spaces: [
      {
        id: 1,
        taskId: "Agent Focus Isolation",
        name: "Agent Focus Isolation",
        createdBy: "agent",
        ownership: "agent",
        lifecycle: "active",
        profileId: "default",
        tabs: [
          {
            targetId: "agent-focus-page",
            url: "x-browser://newtab/",
            title: "New Tab",
            createdAt: now,
          },
        ],
        activeTabId: "agent-focus-page",
        agentTask: {
          title: "Agent Focus Isolation",
          detail: "macOS focus and cursor isolation audit",
          completed: 0,
          total: 1,
          updatedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

async function stopTestApp() {
  return execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")], {
    cwd: root,
    env: testEnv,
  });
}

async function waitForTestSocket(launchedAt, timeoutMs) {
  const marker = join(testRoot, "socket-path");
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(marker);
      if (metadata.mtimeMs >= launchedAt - 250) {
        const path = (await readFile(marker, "utf8")).trim();
        await connectOnce(path);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`test App socket did not become ready: ${String(lastError)}`);
}

function connectOnce(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
  });
}

async function waitForDiagnostics(launchedAt, predicate, timeoutMs) {
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
      // The diagnostic file can be between truncate and write.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`focus diagnostics timed out: ${JSON.stringify(latest)}`);
}

function runCli(source) {
  return new Promise((resolve, reject) => {
    const process = spawn(cli, ["nodejs"], {
      cwd: root,
      env: testEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => (stdout += String(chunk)));
    process.stderr.on("data", (chunk) => (stderr += String(chunk)));
    process.once("error", reject);
    process.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || stdout || `ufo-browser exited ${code}`));
    });
    process.stdin.end(source);
  });
}

async function systemState() {
  const source = String.raw`
import AppKit
import CoreGraphics
let app = NSWorkspace.shared.frontmostApplication
let point = CGEvent(source: nil)?.location ?? CGPoint(x: -1, y: -1)
let pid = app?.processIdentifier ?? -1
let bundle = app?.bundleIdentifier ?? ""
let name = app?.localizedName ?? ""
print("\(pid)\t\(bundle)\t\(name)\t\(point.x)\t\(point.y)")
`;
  const { stdout } = await execFileAsync("/usr/bin/swift", ["-e", source]);
  const [pid, bundleId, name, x, y] = stdout.trim().split("\t");
  return {
    pid: Number(pid),
    bundleId,
    name,
    cursor: { x: Number(x), y: Number(y) },
  };
}

async function waitForSystemState(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await systemState();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`system foreground timed out: ${JSON.stringify(latest)}`);
}

async function activateBundle(bundleId) {
  const source = `
import AppKit
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: ${JSON.stringify(bundleId)})
if let app = apps.first {
  print(app.activate(options: [.activateIgnoringOtherApps]) ? "activated" : "failed")
} else {
  print("missing")
}
`;
  const { stdout } = await execFileAsync("/usr/bin/swift", ["-e", source]);
  if (stdout.trim() !== "activated") {
    throw new Error(`could not activate ${bundleId}: ${stdout.trim()}`);
  }
}

async function activateProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const source = `
import AppKit
if let app = NSRunningApplication(processIdentifier: ${pid}) {
  print(app.activate(options: [.activateIgnoringOtherApps]) ? "activated" : "failed")
} else {
  print("missing")
}
`;
  await execFileAsync("/usr/bin/swift", ["-e", source]);
}
