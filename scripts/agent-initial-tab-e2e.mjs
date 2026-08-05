import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";

const root = process.cwd();
const testNamespace = "agent-initial-tab";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.X_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
let electron;
let taskId;

const server = createServer((request, response) => {
  const name = request.url === "/second" ? "Second Page" : "First Page";
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>${name}</title><main>${name}</main>`);
});

try {
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]);
  await rm(testRoot, { recursive: true, force: true });
  const port = await listen(server);
  electron = spawn(join(root, "node_modules/.bin/electron"), ["."], {
    cwd: root,
    env: { ...process.env, X_BROWSER_TEST_APP: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForTestSocket(20_000);

  const audit = JSON.parse(
    await runCli(`
const task = await useOrCreateTaskSpace('agent initial tab parity')
const before = await listTabs()
const first = await openOrReuseTab('http://127.0.0.1:${port}/first', { wait: true, timeout: 10 })
const afterFirst = await listTabs()
const firstPage = await pageInfo()
const second = await openOrReuseTab('http://127.0.0.1:${port}/second', { wait: true, timeout: 10 })
const afterSecond = await listTabs()
cliLog(JSON.stringify({ taskId: task.id, before, first, afterFirst, firstPage, second, afterSecond }, null, 2))
`),
  );
  taskId = audit.taskId;

  assert.equal(audit.before.length, 1);
  assert.equal(audit.before[0].url, "x-browser://newtab/");
  assert.equal(audit.afterFirst.length, 1);
  assert.equal(audit.afterFirst[0].targetId, audit.before[0].targetId);
  assert.equal(audit.first.targetId, audit.before[0].targetId);
  assert.equal(audit.firstPage.title, "First Page");
  assert.equal(audit.afterSecond.length, 2);
  assert.notEqual(audit.second.targetId, audit.first.targetId);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        taskId: audit.taskId,
        initialTargetId: audit.before[0].targetId,
        firstTargetId: audit.first.targetId,
        tabsAfterFirstOpen: audit.afterFirst.length,
        tabsAfterSecondOpen: audit.afterSecond.length,
      },
      null,
      2,
    )}\n`,
  );
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
  await new Promise((resolve) => server.close(() => resolve()));
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
  return runProcess(join(root, "dist/bin/x-browser"), ["nodejs"], source);
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
