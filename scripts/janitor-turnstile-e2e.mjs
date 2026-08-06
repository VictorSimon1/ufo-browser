import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

const root = process.cwd();
const testNamespace = "janitor-turnstile";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
const screenshotPath = join(testRoot, "janitor-turnstile-e2e.png");
let electron;
let taskId;

try {
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]);
  electron = spawn(join(root, "node_modules/.bin/electron"), ["."], {
    cwd: root,
    env: { ...process.env, X_BROWSER_TEST_APP: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let electronLog = "";
  electron.stderr.on("data", (chunk) => {
    electronLog += String(chunk);
    if (electronLog.length > 24_000) electronLog = electronLog.slice(-24_000);
  });
  await waitForTestSocket(20_000);

  const output = await runCli(`
const task = await useOrCreateTaskSpace(${JSON.stringify(`janitor turnstile e2e ${Date.now()}`)})
await openOrReuseTab('https://janitorai.com/register', { wait: true, timeout: 30 })
let state
for (let attempt = 0; attempt < 55; attempt += 1) {
  state = await js(String.raw\`(() => {
    const tokens = [...document.querySelectorAll('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]')]
      .map(node => String(node.value || ''))
      .sort((left, right) => right.length - left.length)
    return {
      tokenLength: tokens[0]?.length || 0,
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      title: document.title,
      url: location.href,
    }
  })()\`)
  if (state.tokenLength > 100) break
  await wait(1)
}
const screenshot = await captureScreenshot(${JSON.stringify(screenshotPath)})
cliLog(JSON.stringify({ taskId: task.id, ...state, screenshot }, null, 2))
`);
  const audit = JSON.parse(output);
  taskId = audit.taskId;
  assert.match(audit.url, /^https:\/\/janitorai\.com\/register/);
  assert.equal(audit.visibilityState, "visible");
  assert.equal(audit.hasFocus, false);
  assert.ok(
    audit.tokenLength > 100,
    `JanitorAI Turnstile did not produce a response token: ${JSON.stringify(audit)}`,
  );
  const evidence = { ok: true, ...audit };
  await mkdir(testRoot, { recursive: true });
  await writeFile(
    join(testRoot, "janitor-turnstile-audit.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  await mkdir(testRoot, { recursive: true }).catch(() => undefined);
  await writeFile(
    join(testRoot, "janitor-turnstile-audit.json"),
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
}

async function waitForTestSocket(timeoutMs) {
  const socketPath = join(testRoot, "x-browser.sock");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.once("connect", () => {
          socket.end();
          resolve(undefined);
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("timed out waiting for UFO-Browser test socket");
}

function runCli(code) {
  return runProcess(join(root, "dist/bin/ufo-browser"), ["nodejs"], code);
}

function runProcess(command, args, input) {
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
      else reject(new Error(stderr || stdout || `${command} exited ${code}`));
    });
    child.stdin.end(input || "");
  });
}
