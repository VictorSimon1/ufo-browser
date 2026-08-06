import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";

const root = process.cwd();
const testNamespace = "popup-download";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
const fixture = createFixtureServer();
let electron;
let taskId;

try {
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]);
  const port = await listen(fixture);
  electron = spawn(join(root, "node_modules/.bin/electron"), ["."], {
    cwd: root,
    env: { ...process.env, X_BROWSER_TEST_APP: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let electronLog = "";
  electron.stdout.on("data", (chunk) => (electronLog += String(chunk)));
  electron.stderr.on("data", (chunk) => (electronLog += String(chunk)));
  await waitForTestSocket(20_000);

  const taskName = `popup download e2e ${Date.now()}`;
  const output = await runCli(`
const task = await useOrCreateTaskSpace(${JSON.stringify(taskName)})
const main = await openOrReuseTab('http://127.0.0.1:${port}/main', { wait: true, timeout: 20 })
const beforeClick = await js(String.raw\`(() => {
  const button = document.querySelector('#open')
  const rect = button.getBoundingClientRect()
  const x = rect.x + rect.width / 2
  const y = rect.y + rect.height / 2
  const hit = document.elementFromPoint(x, y)
  return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hit: { id: hit?.id, tag: hit?.tagName }, visibility: document.visibilityState, focused: document.hasFocus() }
})()\`)
await click('#open', { label: 'open named popup' })
await wait(0.5)
let tabs = await listTabs()
const child = tabs.find(tab => tab.title === 'Popup Child')
if (!child) {
  const afterClick = await js(String.raw\`({ popupRef: Boolean(globalThis.popupRef), popupClosed: globalThis.popupRef?.closed ?? null, messages: globalThis.popupMessages, hit: (() => { const r=document.querySelector('#open').getBoundingClientRect(); const el=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return { id: el?.id, tag: el?.tagName }; })() })\`)
  throw new Error('managed popup tab was not created: ' + JSON.stringify({ beforeClick, afterClick, tabs, page: await pageInfo() }))
}
await switchTab(child.targetId)
const childState = await js(String.raw\`({ title: document.title, hasOpener: Boolean(opener), name: window.name })\`)
await switchTab(main.targetId)
await wait(0.2)
const firstMessages = await js(String.raw\`globalThis.popupMessages || []\`)
const countBeforeReuse = (await listTabs()).length
await click('#open', { label: 'reuse named popup' })
await wait(0.4)
tabs = await listTabs()
const reusedChild = tabs.find(tab => tab.title === 'Popup Child')
const reuseMessages = await js(String.raw\`globalThis.popupMessages || []\`)
const pendingDownload = page.waitForEvent('download', { timeout: 5000 })
await click('#download', { label: 'download fixture file' })
const download = await pendingDownload
await switchTab(reusedChild.targetId)
await js(String.raw\`setTimeout(() => window.close(), 0); true\`)
await wait(0.4)
const finalTabs = await listTabs()
cliLog(JSON.stringify({
  taskId: task.id,
  childState,
  firstMessages,
  namedReuse: {
    sameTarget: child.targetId === reusedChild.targetId,
    countBefore: countBeforeReuse,
    countAfter: tabs.length,
    activeTitle: tabs.find(tab => tab.active)?.title,
    messages: reuseMessages,
  },
  download: {
    suggestedFilename: download.suggestedFilename(),
    url: download.url(),
    path: await download.path(),
  },
  close: {
    childRemoved: !finalTabs.some(tab => tab.targetId === reusedChild.targetId),
    activeTitle: finalTabs.find(tab => tab.active)?.title,
  },
}, null, 2))
`);
  const audit = JSON.parse(output);
  taskId = audit.taskId;
  assert.deepEqual(audit.childState, {
    title: "Popup Child",
    hasOpener: true,
    name: "named-popup",
  });
  assert.deepEqual(audit.firstMessages, ["child-ready", "pong"]);
  assert.equal(audit.namedReuse.sameTarget, true);
  assert.equal(audit.namedReuse.countAfter, audit.namedReuse.countBefore);
  assert.equal(audit.namedReuse.activeTitle, "Popup Main");
  assert.deepEqual(audit.namedReuse.messages, [
    "child-ready",
    "pong",
    "child-ready",
    "pong",
  ]);
  assert.equal(audit.download.suggestedFilename, "popup-audit.txt");
  assert.equal(
    audit.download.url,
    `http://127.0.0.1:${port}/download`,
  );
  assert.equal(await readFile(audit.download.path, "utf8"), "x-browser download audit\n");
  assert.equal(audit.close.childRemoved, true);
  assert.equal(audit.close.activeTitle, "Popup Main");

  const evidence = { ok: true, ...audit };
  await mkdir(testRoot, { recursive: true });
  await writeFile(
    join(testRoot, "popup-download-audit.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  await mkdir(testRoot, { recursive: true }).catch(() => undefined);
  await writeFile(
    join(testRoot, "popup-download-audit.json"),
    `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
  ).catch(() => undefined);
  throw error;
} finally {
  if (taskId) {
    await runCli(`
const task = await useOrCreateTaskSpace(${Number(taskId)})
cliLog(await completeTaskSpace(task.id, { keep: false }))
`).catch(() => undefined);
  }
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]).catch(
    () => undefined,
  );
  electron?.kill("SIGTERM");
  await closeServer(fixture);
}

function createFixtureServer() {
  return createServer((request, response) => {
    if (request.url === "/child") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><title>Popup Child</title><main>Child ready</main><script>addEventListener("message",event=>{if(event.data==="ping") event.source?.postMessage("pong","*")});opener?.postMessage("child-ready","*");</script>',
      );
      return;
    }
    if (request.url === "/download") {
      response.setHeader("content-type", "text/plain");
      response.setHeader(
        "content-disposition",
        "attachment; filename=popup-audit.txt",
      );
      response.end("x-browser download audit\n");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      '<!doctype html><title>Popup Main</title><button id="open">Open named popup</button><a id="download" href="/download">Download file</a><script>globalThis.popupMessages=[];addEventListener("message",event=>popupMessages.push(event.data));document.querySelector("#open").addEventListener("click",()=>{globalThis.popupRef=window.open("/child","named-popup");setTimeout(()=>popupRef?.postMessage("ping","*"),150)});</script>',
    );
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
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

function runProcess(command, args, stdin = "") {
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
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
    child.stdin.end(stdin);
  });
}
