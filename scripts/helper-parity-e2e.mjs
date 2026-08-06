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

  const ego = await runHelperAudit(
    runEgoCli,
    `ego helper parity ${Date.now()}`,
    fixtureUrl,
    egoScreenshot,
    "Ego",
  );
  egoTaskId = ego.taskId;
  const xBrowser = await runHelperAudit(
    runCli,
    `x-browser helper parity ${Date.now()}`,
    fixtureUrl,
    xBrowserScreenshot,
    "UFO-Browser",
  );
  xBrowserTaskId = xBrowser.taskId;

  assert.deepEqual(
    xBrowser.result,
    ego.result,
    "the same flat-helper Skill script must produce the same observable result",
  );
  assert.ok((await stat(egoScreenshot)).size > 1_000);
  assert.ok((await stat(xBrowserScreenshot)).size > 1_000);

  const evidence = {
    ok: true,
    fixtureUrl,
    ego: { taskId: ego.taskId, screenshot: egoScreenshot },
    xBrowser: { taskId: xBrowser.taskId, screenshot: xBrowserScreenshot },
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
const task = await useOrCreateTaskSpace(${JSON.stringify(taskName)})
await openOrReuseTab(${JSON.stringify(fixtureUrl)}, { wait: true, timeout: 20 })
const initialSnapshot = await snapshotText()
const screenshot = 'local helper-name shadow remains legal'
await fillInput('#name', 'Ada Lovelace')
await click('#agree')
await js(${JSON.stringify(setExtendedForm)})
await click('#increment')
await waitForElement('.item:nth-child(3)', { timeout: 5 })
const form = await js(${JSON.stringify(readForm)})
await captureScreenshot(${JSON.stringify(screenshotPath)})
await click('#navigate')
await waitForElement('#result', { timeout: 10 })
const page = await pageInfo()
const resultText = await js("document.querySelector('#result').textContent")
const browserResponse = JSON.parse(await browserFetch(${JSON.stringify(apiUrl)}))
const serverResponse = JSON.parse(await serverFetch(${JSON.stringify(apiUrl)}))
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
cliLog('__X_BROWSER_HELPER_PARITY__' + JSON.stringify({ taskId: task.id, result }))
`;
}

async function runHelperAudit(runner, taskName, fixtureUrl, screenshotPath, label) {
  const output = await runner(
    helperAuditSource(taskName, fixtureUrl, screenshotPath),
  );
  const marker = "__X_BROWSER_HELPER_PARITY__";
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(marker));
  if (!line) throw new Error(`${label} helper audit did not emit its result: ${output}`);
  return JSON.parse(line.slice(marker.length));
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
