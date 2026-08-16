import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const testNamespace = "snapshot-delta";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
let electron;
let taskId;
let oopifPort = 0;

const oopifServer = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>OOPIF Snapshot</title><button>Frame action</button>");
});

const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/next") {
    response.end("<!doctype html><title>Next Document</title><button id='next'>Next document</button>");
    return;
  }
  const articles = Array.from(
    { length: 80 },
    (_, index) => `<article><h2>Outside item ${index}</h2><p>Long description ${index}</p><a href="/outside-${index}">Open outside ${index}</a></article>`,
  ).join("");
  response.end(`<!doctype html>
    <title>Snapshot V2 Fixture</title>
    <main>
      <form id="register-form" aria-label="Register">
        <label>Email <input id="email" aria-label="Email"></label>
        <button id="send" type="button">Send code</button>
        <div id="dialog-host"></div>
      </form>
      <iframe id="oopif-frame" src="http://oopif.localhost:${oopifPort}/frame"></iframe>
      <button id="offscreen" style="display:block;margin-top:3000px">Offscreen action</button>
      <section id="outside">${articles}</section>
    </main>
    <script>
      document.querySelector('#send').addEventListener('click', () => {
        document.querySelector('#send').textContent = 'Code sent';
        document.querySelector('#send').disabled = true;
        document.querySelector('#dialog-host').innerHTML = '<div role="dialog" aria-label="Verification"><p>Enter code</p>' + Array.from({length: 6}, (_, i) => '<input aria-label="Digit ' + (i + 1) + '">').join('') + '</div>';
      });
    </script>`);
});

try {
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]).catch(() => undefined);
  await rm(testRoot, { recursive: true, force: true });
  oopifPort = await listen(oopifServer);
  const port = await listen(server);
  electron = spawn(join(root, "node_modules/.bin/electron"), ["."], {
    cwd: root,
    env: { ...process.env, X_BROWSER_TEST_APP: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForTestSocket(20_000);

  const audit = JSON.parse(
    await runCli(`
const task = await bootstrapTaskSpace({
  name: 'snapshot delta e2e',
  url: 'http://127.0.0.1:${port}/'
})
let oopifTargetId = null
for (let attempt = 0; attempt < 50 && !oopifTargetId; attempt += 1) {
  oopifTargetId = await iframeTarget('oopif.localhost')
  if (!oopifTargetId) await new Promise(resolve => setTimeout(resolve, 20))
}
if (!oopifTargetId) throw new Error('OOPIF target did not become available')
const fullStarted = performance.now()
const full = await snapshotRaw({ urls: true })
const fullMs = performance.now() - fullStarted
const compactStarted = performance.now()
const compact = await snapshotRaw({ interactive: true, compact: true, urls: true })
const facadeStructured = await page.snapshot({ format: 'structured', interactive: true, compact: true, urls: true })
const compactMs = performance.now() - compactStarted
const scoped = await snapshotRaw({ selector: '#register-form', compact: true, urls: true })
const scopedText = await snapshotText({ selector: '#register-form', compact: true, urls: true })
const viewport = await snapshotRaw({ scope: 'only_within_viewport', interactive: true })
const boxed = await snapshotRaw({ interactive: true, compact: true, boxes: true })
const fullSend = full.refs.find(ref => ref.name === 'Send code')
const compactSend = compact.refs.find(ref => ref.name === 'Send code')
const fullFrameAction = full.refs.find(ref => ref.name === 'Frame action')
const compactFrameAction = compact.refs.find(ref => ref.name === 'Frame action')
const boxedSend = boxed.refs.find(ref => ref.name === 'Send code')
await click('@' + compactSend.refId)
const deltaStarted = performance.now()
const delta = await snapshotRaw({
  interactive: true,
  compact: true,
  urls: true,
  sinceRevision: compact.revision
})
const deltaMs = performance.now() - deltaStarted
const deltaText = await snapshotText({
  interactive: true,
  compact: true,
  urls: true,
  sinceRevision: compact.revision
})
await gotoAndWait('http://127.0.0.1:${port}/next', { timeout: 10 })
const navigated = await snapshotRaw({
  interactive: true,
  compact: true,
  urls: true,
  sinceRevision: compact.revision
})
cliLog(JSON.stringify({
  taskId: task.id,
  fullBytes: full.content.length,
  compactBytes: compact.content.length,
  deltaBytes: delta.content.length,
  fullMs, compactMs, deltaMs,
  fullRef: fullSend?.refId,
  compactRef: compactSend?.refId,
  fullFrameRef: fullFrameAction?.refId,
  compactFrameRef: compactFrameAction?.refId,
  frameTargetId: fullFrameAction?.frameId,
  facadeStructuredKind: facadeStructured.kind,
  facadeStructuredRevision: facadeStructured.revision,
  scopedContent: scoped.content,
  scopedText,
  viewportContent: viewport.content,
  boxed: boxedSend?.box,
  deltaKind: delta.kind,
  deltaChanges: delta.changes,
  deltaContent: delta.content,
  deltaText,
  navigatedKind: navigated.kind,
  navigatedFallback: navigated.fallbackReason
}))
`),
  );
  taskId = audit.taskId;
  assert.ok(audit.fullBytes > audit.compactBytes * 3, JSON.stringify(audit));
  assert.ok(audit.deltaBytes < audit.compactBytes, JSON.stringify(audit));
  assert.ok(audit.deltaMs < audit.fullMs, JSON.stringify(audit));
  assert.equal(audit.fullRef, audit.compactRef);
  assert.equal(audit.fullFrameRef, audit.compactFrameRef);
  assert.equal(typeof audit.frameTargetId, 'string');
  assert.equal(audit.facadeStructuredKind, 'full');
  assert.equal(typeof audit.facadeStructuredRevision, 'string');
  assert.match(audit.scopedContent, /Register/);
  assert.doesNotMatch(audit.scopedContent, /Outside item/);
  assert.match(audit.scopedText, /Register/);
  assert.doesNotMatch(audit.scopedText, /Outside item/);
  assert.match(audit.viewportContent, /Email|Send code/);
  assert.doesNotMatch(audit.viewportContent, /Offscreen action/);
  assert.ok(audit.boxed?.width > 0 && audit.boxed?.height > 0);
  assert.equal(audit.deltaKind, "delta");
  assert.ok(audit.deltaChanges.changed >= 1);
  assert.ok(audit.deltaChanges.added >= 6);
  assert.match(audit.deltaContent, /Verification|Digit 1/);
  assert.match(audit.deltaText, /revision:/);
  assert.match(audit.deltaText, /Verification|Digit 1/);
  assert.equal(audit.navigatedKind, "full");
  assert.equal(audit.navigatedFallback, "document-changed");
  process.stdout.write(`${JSON.stringify({ ok: true, ...audit }, null, 2)}\n`);
} finally {
  if (taskId) {
    await runCli(`
await useTaskSpace(${Number(taskId)})
await completeTaskSpace(${Number(taskId)}, { keep: false })
`).catch(() => undefined);
  }
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]).catch(() => undefined);
  electron?.kill("SIGTERM");
  await new Promise((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => oopifServer.close(() => resolve()));
}

function listen(httpServer) {
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve(httpServer.address().port);
    });
  });
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
    socket.once("connect", () => { socket.end(); resolve(); });
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
