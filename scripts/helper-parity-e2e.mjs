import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";

const root = process.cwd();
const testNamespace = "helper-parity";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
const egoScreenshot = join(testRoot, "ego-helper-parity.png");
const xBrowserScreenshot = join(testRoot, "x-browser-helper-parity.png");
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");

let electron;
let server;
let egoTaskId;
let xBrowserTaskId;

try {
  await mkdir(testRoot, { recursive: true });
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]);
  server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    if (url.pathname === "/api") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: true, source: "helper-parity" }));
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/done") {
      response.end(`<!doctype html>
        <meta charset="utf-8">
        <title>Parity Complete</title>
        <main id="result">Done for ${escapeHtml(url.searchParams.get("name") || "")}</main>`);
      return;
    }
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <title>Helper Parity Fixture</title>
      <main>
        <h1>Parity Fixture</h1>
        <label>Name <input id="name" placeholder="Your name"></label>
        <label><input id="agree" type="checkbox"> Accept terms</label>
        <label>Role
          <select id="role">
            <option value="designer">Designer</option>
            <option value="engineer">Engineer</option>
          </select>
        </label>
        <textarea id="note"></textarea>
        <button id="increment" type="button">Increment</button>
        <span id="count">0</span>
        <div id="status" data-state="idle">Idle</div>
        <ul><li class="item">Alpha</li><li class="item">Beta</li></ul>
        <a id="navigate" href="/done">Finish</a>
      </main>
      <script>
        document.querySelector('#increment').addEventListener('click', () => {
          document.querySelector('#count').textContent = '1';
          const status = document.querySelector('#status');
          status.dataset.state = 'ready';
          status.textContent = 'Ready';
          setTimeout(() => {
            const item = document.createElement('li');
            item.className = 'item';
            item.textContent = 'Gamma';
            document.querySelector('ul').append(item);
          }, 80);
        });
        document.querySelector('#navigate').addEventListener('click', event => {
          event.preventDefault();
          location.href = '/done?name=' + encodeURIComponent(document.querySelector('#name').value);
        });
      </script>`);
  });
  const port = await listen(server);
  const fixtureUrl = `http://127.0.0.1:${port}/main`;

  electron = spawn(join(root, "node_modules/.bin/electron"), ["."], {
    cwd: root,
    env: { ...process.env, X_BROWSER_TEST_APP: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForTestSocket(20_000);

  const egoCapability = await probeEgoCapability();
  const ego = egoCapability.bootstrapTaskSpace
    ? await runHelperAudit(
        runEgoCli,
        `ego helper parity ${Date.now()}`,
        fixtureUrl,
        egoScreenshot,
        "Ego",
      )
    : null;
  egoTaskId = ego?.taskId;
  const xBrowser = await runHelperAudit(
    runCli,
    `x-browser helper parity ${Date.now()}`,
    fixtureUrl,
    xBrowserScreenshot,
    "UFO-Browser",
  );
  xBrowserTaskId = xBrowser.taskId;

  validateRuntimeState(xBrowser.runtimeState, "UFO-Browser");
  assert.ok((await stat(xBrowserScreenshot)).size > 1_000);
  let performanceRatio = null;
  if (ego) {
    validateRuntimeState(ego.runtimeState, "Ego");
    assert.deepEqual(
      xBrowser.result,
      ego.result,
      "the same flat-helper Skill script must produce the same observable result",
    );
    assert.deepEqual(
      xBrowser.contract,
      ego.contract,
      "the shared Ego runtime contract must have the same globals and shapes",
    );
    assert.ok((await stat(egoScreenshot)).size > 1_000);
    performanceRatio = Number(
      (xBrowser.timings.totalMs / Math.max(1, ego.timings.totalMs)).toFixed(3),
    );
    assert.ok(
      xBrowser.timings.totalMs <= Math.max(2_000, ego.timings.totalMs * 1.75),
      `UFO-Browser helper workflow regressed beyond the Ego performance budget: ${JSON.stringify({ ego: ego.timings, xBrowser: xBrowser.timings })}`,
    );
  }

  const evidence = {
    ok: true,
    fixtureUrl,
    reference: {
      comparable: Boolean(ego),
      capability: egoCapability,
      skippedReason: ego
        ? null
        : "Installed Ego reference does not expose bootstrapTaskSpace; UFO self-contract still passed.",
    },
    ego: ego
      ? {
          taskId: ego.taskId,
          screenshot: egoScreenshot,
          timings: ego.timings,
          processElapsedMs: ego.processElapsedMs,
          extensions: ego.extensions,
        }
      : null,
    xBrowser: {
      taskId: xBrowser.taskId,
      screenshot: xBrowserScreenshot,
      timings: xBrowser.timings,
      processElapsedMs: xBrowser.processElapsedMs,
      extensions: xBrowser.extensions,
    },
    performanceRatio,
    contract: xBrowser.contract,
    runtimeState: {
      ego: ego?.runtimeState || null,
      xBrowser: xBrowser.runtimeState,
    },
    result: xBrowser.result,
  };
  await writeFile(
    join(testRoot, "helper-parity-audit.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  await mkdir(testRoot, { recursive: true }).catch(() => undefined);
  await writeFile(
    join(testRoot, "helper-parity-audit.json"),
    `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
  ).catch(() => undefined);
  throw error;
} finally {
  if (xBrowserTaskId) {
    await runCli(`
cliLog(await completeTaskSpace(${Number(xBrowserTaskId)}, { keep: false }))
`).catch(() => undefined);
  }
  if (egoTaskId) {
    await runEgoCli(`
cliLog(JSON.stringify(await completeTaskSpace(${Number(egoTaskId)}, { keep: false })))
`).catch(() => undefined);
  }
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]).catch(
    () => undefined,
  );
  electron?.kill("SIGTERM");
  await closeServer(server);
}

async function probeEgoCapability() {
  const marker = "__UFO_EGO_CAPABILITY__";
  try {
    const output = await runEgoCli(`
const capability = {
  bootstrapTaskSpace: typeof bootstrapTaskSpace === 'function',
  getBrowserVersion: typeof getBrowserVersion === 'function',
  version: typeof getBrowserVersion === 'function'
    ? await getBrowserVersion().catch(() => null)
    : null,
}
cliLog(${JSON.stringify(marker)} + JSON.stringify(capability))
`);
    const line = output
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith(marker));
    if (!line) {
      return {
        bootstrapTaskSpace: false,
        probeError: "Ego capability probe emitted no marker",
      };
    }
    return JSON.parse(line.slice(marker.length));
  } catch (error) {
    return {
      bootstrapTaskSpace: false,
      probeError: String(error),
    };
  }
}

function helperAuditSource(taskName, fixtureUrl, screenshotPath) {
  const apiUrl = new URL("/api", fixtureUrl).toString();
  const setExtendedForm = String.raw`(() => {
    const role = document.querySelector('#role')
    role.value = 'engineer'
    role.dispatchEvent(new Event('change', { bubbles: true }))
    const note = document.querySelector('#note')
    note.value = 'same Skill script'
    note.dispatchEvent(new Event('input', { bubbles: true }))
  })()`;
  const readForm = String.raw`(() => ({
    name: document.querySelector('#name').value,
    agreed: document.querySelector('#agree').checked,
    role: document.querySelector('#role').value,
    note: document.querySelector('#note').value,
    countText: document.querySelector('#count').textContent,
    statusText: document.querySelector('#status').innerText,
    statusState: document.querySelector('#status').getAttribute('data-state'),
    itemCount: document.querySelectorAll('.item').length,
    items: [...document.querySelectorAll('.item')].map(item => item.innerText),
  }))()`;
  return `
const auditStartedAt = performance.now()
const timings = {}
const measure = async (name, operation) => {
  const startedAt = performance.now()
  const value = await operation()
  timings[name] = Math.round((performance.now() - startedAt) * 10) / 10
  return value
}
const resultOf = async operation => {
  try { return { ok: true, value: await operation() } }
  catch (error) { return { ok: false, name: error?.name, message: error?.message } }
}
if (typeof bootstrapTaskSpace !== 'function') {
  throw new Error('helper parity requires bootstrapTaskSpace on both runtimes')
}
const task = await bootstrapTaskSpace({ name: ${JSON.stringify(taskName)} })
const contractNames = [
  'createTab',
  'getBrowserVersion',
  'listProfiles',
  'markTaskSpaceError',
  'sendCDPMessage',
  'setAgentTaskState',
  'animationHighlightMouseToPosition',
  'iframeTarget',
  'fetch',
  'openOrReuseTab',
  'snapshotText',
  'captureScreenshot',
]
const descriptors = Object.fromEntries(contractNames.map(name => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  return [name, {
    type: typeof globalThis[name],
    own: Boolean(descriptor),
    enumerable: descriptor?.enumerable ?? null,
    writable: descriptor?.writable ?? null,
    configurable: descriptor?.configurable ?? null,
  }]
}))
const version = await measure('version', () => getBrowserVersion())
const profiles = await measure('profiles', () => listProfiles())
const noArgCreateTab = await resultOf(() => createTab())
const profileEntries = Array.isArray(profiles?.profiles) ? profiles.profiles : []
const profileShapes = [...new Set(profileEntries.map(profile => JSON.stringify({
  keys: Object.keys(profile).sort(),
  idType: typeof profile.id,
  isDefaultType: typeof profile.isDefault,
  nameType: typeof profile.name,
})))].sort().map(shape => JSON.parse(shape))
const contract = {
  descriptors,
  version: {
    keys: Object.keys(version).sort(),
    currentVersionType: typeof version.currentVersion,
    updateAvailableType: typeof version.updateAvailable,
  },
  profiles: {
    keys: Object.keys(profiles).sort(),
    profilesType: Array.isArray(profiles?.profiles) ? 'array' : typeof profiles?.profiles,
    entryShapes: profileShapes,
  },
  noArgCreateTab: {
    ok: noArgCreateTab.ok,
    name: noArgCreateTab.name,
    message: noArgCreateTab.message,
  },
}
const runtimeState = {
  updateAvailable: version.updateAvailable,
  profileCount: profileEntries.length,
  defaultProfileCount: profileEntries.filter(profile => profile.isDefault === true).length,
  uniqueProfileIds: new Set(profileEntries.map(profile => profile.id)).size === profileEntries.length,
  validProfileIds: profileEntries.every(profile => typeof profile.id === 'string' && profile.id.length > 0),
}
const extensions = {
  waitForRequest: typeof waitForRequest,
  waitForResponse: typeof waitForResponse,
  startScreencast: typeof startScreencast,
  stopScreencast: typeof stopScreencast,
  waitForDownload: typeof waitForDownload,
}
await measure('open', () => openOrReuseTab(${JSON.stringify(fixtureUrl)}, { wait: true, timeout: 20 }))
const initialSnapshot = await measure('snapshot', () => snapshotText())
const screenshot = 'local helper-name shadow remains legal'
await measure('input', async () => {
  await fillInput('#name', 'Ada Lovelace')
  await click('#agree')
  await js(${JSON.stringify(setExtendedForm)})
  await click('#increment')
  await waitForElement('.item:nth-child(3)', { timeout: 5 })
})
const form = await js(${JSON.stringify(readForm)})
await measure('screenshot', () => captureScreenshot(${JSON.stringify(screenshotPath)}))
await measure('navigate', async () => {
  await click('#navigate')
  await waitForElement('#result', { timeout: 10 })
})
const page = await pageInfo()
const resultText = await js("document.querySelector('#result').textContent")
const responses = await measure('fetch', async () => ({
  browserResponse: JSON.parse(await browserFetch(${JSON.stringify(apiUrl)})),
  serverResponse: JSON.parse(await serverFetch(${JSON.stringify(apiUrl)})),
}))
const { browserResponse, serverResponse } = responses
const result = {
  initialSnapshot: initialSnapshot.includes('Parity Fixture') && initialSnapshot.includes('Accept terms'),
  localShadow: screenshot,
  form,
  urlMatched: new URL(page.url).pathname === '/done',
  finalPath: new URL(page.url).pathname,
  resultText,
  browserResponse,
  serverResponse,
}
timings.totalMs = Math.round((performance.now() - auditStartedAt) * 10) / 10
cliLog('__X_BROWSER_HELPER_PARITY__' + JSON.stringify({ taskId: task.id, contract, runtimeState, extensions, timings, result }))
`;
}

function validateRuntimeState(state, label) {
  assert.equal(
    typeof state?.updateAvailable,
    "boolean",
    `${label} must expose a boolean updateAvailable state`,
  );
  assert.ok(
    Number.isInteger(state?.profileCount) && state.profileCount >= 1,
    `${label} must expose at least one browser profile`,
  );
  assert.equal(
    state.defaultProfileCount,
    1,
    `${label} must expose exactly one default browser profile`,
  );
  assert.equal(state.uniqueProfileIds, true, `${label} profile ids must be unique`);
  assert.equal(state.validProfileIds, true, `${label} profile ids must be non-empty strings`);
}

async function runHelperAudit(runner, taskName, fixtureUrl, screenshotPath, label) {
  const startedAt = performance.now();
  const output = await runner(
    helperAuditSource(taskName, fixtureUrl, screenshotPath),
  );
  const marker = "__X_BROWSER_HELPER_PARITY__";
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(marker));
  if (!line) throw new Error(`${label} helper audit did not emit its result: ${output}`);
  return {
    ...JSON.parse(line.slice(marker.length)),
    processElapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
  };
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      target.off("error", reject);
      resolve(target.address().port);
    });
  });
}

function closeServer(target) {
  if (!target) return Promise.resolve();
  target.closeIdleConnections?.();
  target.closeAllConnections?.();
  return new Promise((resolve) => target.close(() => resolve()));
}

async function waitForTestSocket(timeoutMs) {
  const marker = join(testRoot, "socket-path");
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const socketPath = (await readFile(marker, "utf8")).trim();
      await connectOnce(socketPath);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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

function runCli(source) {
  return runProcess(join(root, "dist/bin/ufo-browser"), ["nodejs"], source);
}

function runEgoCli(source) {
  return runProcess("ego-browser", ["nodejs"], source, "stderr");
}

function runProcess(command, args, stdin = "", outputStream = "stdout") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve((outputStream === "stderr" ? stderr : stdout).trim());
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
      }
    });
    child.stdin.end(stdin);
  });
}
