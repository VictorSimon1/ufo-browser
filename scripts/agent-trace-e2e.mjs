import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const testNamespace = "agent-trace";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
const eventRoot = join(testRoot, "user-data", "Agent Events");
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
let electron;
let taskId;

const server = createServer((request, response) => {
  if (request.url === "/submit") {
    response.statusCode = 429;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "rate limited" }));
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
    <title>Agent Trace Fixture</title>
    <label>Email <input id="email" aria-label="Email"></label>
    <button id="submit">Submit</button>
    <output id="status"></output>
    <script>
      document.querySelector('#submit').addEventListener('click', async () => {
        const response = await fetch('/submit');
        document.querySelector('#status').textContent = String(response.status);
      });
    </script>`);
});

try {
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]).catch(
    () => undefined,
  );
  await rm(testRoot, { recursive: true, force: true });
  const port = await listen(server);
  electron = await startElectron();

  const first = JSON.parse(
    await runCli(`
const task = await bootstrapTaskSpace({
  name: 'agent trace e2e',
  url: 'http://127.0.0.1:${port}/'
})
await snapshotText()
await fillInput('#email', 'sensitive-agent@example.com')
await click('#submit')
await wait(0.2)
const trace = await listAgentTrace(task.id, { limit: 100 })
const events = await listSpaceEvents(task.id, { limit: 200 })
const exported = await exportAgentTrace(task.id, {
  path: ${JSON.stringify(join(testRoot, "agent-trace.md"))},
  format: 'markdown'
})
cliLog(JSON.stringify({ taskId: task.id, trace, events, exported }))
`),
  );
  taskId = first.taskId;
  assert.ok(
    first.trace.events.some(
      (event) =>
        event.type === "action.finished" &&
        event.data?.action === "fillInput" &&
        event.data?.status === "success",
    ),
  );
  assert.ok(
    first.events.events.some(
      (event) =>
        event.type === "action.finished" && event.data?.action === "click",
    ),
  );
  const lastSequence = first.events.latestSequence;
  assert.ok(lastSequence > 0);

  await stopElectron();
  electron = await startElectron();
  const restored = JSON.parse(
    await runCli(`
await useTaskSpace(${Number(taskId)})
const prior = await listSpaceEvents(${Number(taskId)}, { after: 0, limit: 200 })
const delta = await listSpaceEvents(${Number(taskId)}, { after: ${Number(lastSequence)}, limit: 200 })
cliLog(JSON.stringify({ prior, delta }))
`),
  );
  assert.ok(restored.prior.events.length > 0);
  assert.ok(restored.prior.latestSequence >= lastSequence);
  assert.equal(restored.delta.cursorExpired, false);

  const persistedFiles = await readdir(eventRoot);
  const persisted = await Promise.all(
    persistedFiles
      .filter((name) => name.endsWith(".json"))
      .map((name) => readFile(join(eventRoot, name), "utf8")),
  );
  const exported = await readFile(join(testRoot, "agent-trace.md"), "utf8");
  assert.doesNotMatch(
    `${persisted.join("\n")}\n${exported}`,
    /sensitive-agent@example\.com/,
  );

  const temporaryTask = JSON.parse(
    await runCli(`
const task = await bootstrapTaskSpace({
  name: 'temporary trace cleanup',
  profileId: 'Temporary',
  url: 'http://127.0.0.1:${port}/'
})
await fillInput('#email', 'temporary-secret@example.com')
cliLog(JSON.stringify({ id: task.id }))
`),
  );
  await runCli(`
await useTaskSpace(${Number(temporaryTask.id)})
await completeTaskSpace(${Number(temporaryTask.id)}, { keep: false })
`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    (await readdir(eventRoot)).includes(`space-${Number(temporaryTask.id)}.json`),
    false,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        taskId,
        eventsBeforeRestart: first.events.events.length,
        eventsAfterRestart: restored.prior.events.length,
        latestSequence: restored.prior.latestSequence,
        redacted: true,
        temporaryHistoryCleared: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (taskId && electron) {
    await runCli(`
await useTaskSpace(${Number(taskId)})
cliLog(await completeTaskSpace(${Number(taskId)}, { keep: false }))
`).catch(() => undefined);
  }
  await stopElectron().catch(() => undefined);
  await new Promise((resolve) => server.close(() => resolve()));
}

async function startElectron() {
  const child = spawn(join(root, "node_modules/.bin/electron"), ["."], {
    cwd: root,
    env: { ...process.env, X_BROWSER_TEST_APP: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForTestSocket(20_000);
  return child;
}

async function stopElectron() {
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]).catch(
    () => undefined,
  );
  electron?.kill("SIGTERM");
  electron = undefined;
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
