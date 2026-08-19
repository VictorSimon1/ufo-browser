import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const testNamespace = "workflow-replay";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
const workflowPath = join(
  testRoot,
  "user-data",
  "Agent Workflows",
  "workflows.json",
);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
let electron;
let taskId;
let cachedTaskId;
let sourceTaskId;
const submissions = [];

const server = createServer((request, response) => {
  if (request.url === "/submit" && request.method === "POST") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      submissions.push(JSON.parse(body));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  const variant = new URL(request.url ?? "/", "http://fixture.local").searchParams.get(
    "variant",
  );
  const ids = variant === "2" ? "" : 'id="email"';
  const passwordId = variant === "2" ? "" : 'id="password"';
  const buttonId = variant === "2" ? "" : 'id="continue"';
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
    <title>Workflow Fixture</title>
    <main aria-label="Registration form">
      <label>Email <input ${ids} aria-label="Email"></label>
      <label>Password <input ${passwordId} type="password" aria-label="Password"></label>
      <button ${buttonId}>Continue</button>
      <output aria-label="Status"></output>
    </main>
    <script>
      document.querySelector('button').addEventListener('click', async () => {
        const inputs = document.querySelectorAll('input');
        const result = await fetch('/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: inputs[0].value, password: inputs[1].value }),
        });
        document.querySelector('output').textContent = result.ok ? 'done' : 'failed';
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
  const recordedEmail = "recorded-workflow@example.com";
  const recordedPassword = "recorded-workflow-password";
  const first = JSON.parse(
    await runCli(`
const task = await bootstrapTaskSpace({
  name: 'workflow replay e2e',
  profileId: 'Temporary',
  url: 'http://127.0.0.1:${port}/form?variant=1'
})
const recording = await workflows.start('fixture-register')
await page.locator('#email').fill(${JSON.stringify(recordedEmail)})
await page.locator('#password').fill(${JSON.stringify(recordedPassword)})
await page.locator('#continue').click()
await wait(0.15)
const recipe = await recording.finish({
  variables: ['email'],
  secrets: ['password']
})
await completeTaskSpace(task.id, { keep: false })
cliLog(JSON.stringify({ taskId: task.id, recipe }))
`),
  );
  sourceTaskId = first.taskId;
  assert.equal(first.recipe.version, 1);
  assert.equal(first.recipe.steps.length, 3);
  assert.equal(first.recipe.steps[0].target.role, "textbox");
  assert.equal(first.recipe.steps[2].target.name, "Continue");
  assert.equal(submissions.length, 1);

  const replayEmail = "second-run@example.com";
  const replayPassword = "second-run-password";
  const replay = JSON.parse(
    await runCli(`
const task = await bootstrapTaskSpace({
  name: 'workflow replay destination',
  profileId: 'Temporary',
  url: 'http://127.0.0.1:${port}/form?variant=2'
})
const result = await workflows.replay('fixture-register', {
  email: ${JSON.stringify(replayEmail)},
  password: secret(${JSON.stringify(replayPassword)})
})
const recipe = await workflows.get('fixture-register')
cliLog(JSON.stringify({ taskId: task.id, result, recipe }))
`),
  );
  taskId = replay.taskId;
  assert.equal(replay.result.status, "success");
  assert.equal(replay.result.zeroLlm, true);
  assert.equal(replay.result.steps, 3);
  assert.equal(replay.recipe.stats.runs, 1);
  assert.equal(replay.recipe.stats.successes, 1);
  assert.deepEqual(replay.result.actionCache, {
    hits: 0,
    misses: 3,
    fallbacks: 3,
    updates: 3,
  });
  assert.equal(replay.recipe.stats.actionCache.fallbacks, 3);
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions[1], {
    email: replayEmail,
    password: replayPassword,
  });

  const cached = JSON.parse(
    await runCli(`
const task = await bootstrapTaskSpace({
  name: 'workflow action cache destination',
  profileId: 'Temporary',
  url: 'http://127.0.0.1:${port}/form?variant=2'
})
const result = await workflows.replay('fixture-register', {
  email: 'cached-run@example.com',
  password: secret('cached-run-password')
})
const recipe = await workflows.get('fixture-register')
cliLog(JSON.stringify({ taskId: task.id, result, recipe }))
`),
  );
  cachedTaskId = cached.taskId;
  assert.equal(cached.result.status, "success");
  assert.deepEqual(cached.result.actionCache, {
    hits: 3,
    misses: 0,
    fallbacks: 0,
    updates: 0,
  });
  assert.equal(cached.recipe.stats.runs, 2);
  assert.equal(cached.recipe.stats.successes, 2);
  assert.equal(cached.recipe.stats.actionCache.hits, 3);
  assert.equal(cached.recipe.stats.actionCache.misses, 3);
  assert.equal(cached.recipe.stats.actionCache.fallbacks, 3);
  assert.equal(cached.recipe.stats.actionCache.updates, 3);
  assert.equal(submissions.length, 3);

  const persisted = await readFile(workflowPath, "utf8");
  for (const sensitive of [
    recordedEmail,
    recordedPassword,
    replayEmail,
    replayPassword,
    "cached-run@example.com",
    "cached-run-password",
  ]) {
    assert.equal(persisted.includes(sensitive), false);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        workflow: "fixture-register",
        sourceSpaceClosedBeforeReplay: true,
        sourceSpaceId: sourceTaskId,
        replaySpaceId: taskId,
        version: replay.recipe.version,
        steps: replay.result.steps,
        zeroLlmSecondRun: replay.result.zeroLlm,
        recoveredByRoleName: true,
        actionCacheFallbacks: replay.result.actionCache.fallbacks,
        actionCacheHits: cached.result.actionCache.hits,
        persistedSecrets: false,
        stats: replay.recipe.stats,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (taskId && electron) {
    await runCli(`
await useTaskSpace(${Number(taskId)})
await completeTaskSpace(${Number(taskId)}, { keep: false })
    `).catch(() => undefined);
  }
  if (cachedTaskId && electron) {
    await runCli(`
await useTaskSpace(${Number(cachedTaskId)})
await completeTaskSpace(${Number(cachedTaskId)}, { keep: false })
`).catch(() => undefined);
  }
  await stopElectron().catch(() => undefined);
  await new Promise((resolve) => server.close(() => resolve()));
}

async function startElectron() {
  const child = spawn(join(root, "node_modules/.bin/electron"), ["."], {
    cwd: root,
    env: { ...process.env, X_BROWSER_TEST_APP: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  await waitForTestSocket(20_000).catch((error) => {
    throw new Error(`${error.message}\n${stderr}`);
  });
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
