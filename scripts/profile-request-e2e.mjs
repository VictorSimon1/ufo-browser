import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const testNamespace = "profile-request";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
let electron;
let firstTaskId;
let secondTaskId;
const sensitiveAuth = "Bearer profile-e2e-secret-token";
const sensitiveBody = "profile-e2e-secret-body";

const fixture = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture.local");
  if (url.pathname === "/slow") {
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  if (url.pathname === "/set-cookie") {
    response.setHeader(
      "set-cookie",
      "ufo_profile_request=space-a; Path=/; HttpOnly; SameSite=Lax",
    );
  }
  if (url.pathname === "/redirect") {
    response.writeHead(302, { location: "/echo" });
    response.end();
    return;
  }
  if (url.pathname === "/large") {
    response.setHeader("content-type", "text/plain");
    response.end("x".repeat(2_048));
    return;
  }
  if (url.pathname === "/page" || url.pathname === "/busy") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      "<!doctype html><meta charset=utf-8><title>Profile Request</title><main>fixture</main>",
    );
    return;
  }
  const body = await readBody(request);
  response.setHeader("content-type", "application/json");
  // Deliberately omit Access-Control-Allow-Origin. Profile Request must not be
  // subject to page renderer CORS.
  response.end(
    JSON.stringify({
      path: url.pathname,
      cookie: request.headers.cookie ?? "",
      userAgent: request.headers["user-agent"] ?? "",
      acceptLanguage: request.headers["accept-language"] ?? "",
      authorization: request.headers.authorization ?? "",
      body,
    }),
  );
});

try {
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]).catch(
    () => undefined,
  );
  await rm(testRoot, { recursive: true, force: true });
  const port = await listen(fixture);
  const origin = `http://127.0.0.1:${port}`;
  electron = await startElectron();

  const first = JSON.parse(
    await runCli(`
const task = await bootstrapTaskSpace({
  name: 'Profile Request A',
  profileId: 'Temporary'
})
const setCookie = await fetch.profile('${origin}/set-cookie')
const absolute = await page.request('${origin}/echo')
const absoluteBody = await absolute.json()
await page.goto('${origin}/page', { waitUntil: 'domcontentloaded' })
const relative = await page.request('/echo')
const relativeBody = await relative.json()
await page.evaluate(\`setTimeout(() => {
  const end = performance.now() + 1400;
  while (performance.now() < end) {}
}, 0); true\`)
const busyStarted = Date.now()
const busy = await fetch.profile('${origin}/echo')
const busyDurationMs = Date.now() - busyStarted
const redirected = await page.request('${origin}/redirect')
const redirectedBody = await redirected.json()
let redirectErrorCode = ''
try {
  await page.request('${origin}/redirect', { redirect: 'error' })
} catch (error) {
  redirectErrorCode = error.error_code || error.message
}
const sensitiveAuth = ${JSON.stringify(sensitiveAuth)}
const sensitiveBody = ${JSON.stringify(sensitiveBody)}
const sensitive = await page.request('${origin}/echo', {
  method: 'POST',
  headers: { Authorization: sensitiveAuth },
  json: { token: sensitiveBody }
})
const sensitiveEcho = await sensitive.json()
let timeoutCode = ''
try {
  await page.request('${origin}/slow', { timeoutMs: 100 })
} catch (error) {
  timeoutCode = error.error_code || error.message
}
let sizeCode = ''
try {
  await page.request('${origin}/large', { maxResponseBytes: 64 })
} catch (error) {
  sizeCode = error.error_code || error.message
}
let headerCode = ''
try {
  await page.request('${origin}/echo', { headers: { Cookie: 'forbidden=secret' } })
} catch (error) {
  headerCode = error.error_code || error.message
}
const events = await listSpaceEvents(task.id, { categories: ['network'], limit: 100 })
const eventText = JSON.stringify(events)
await handOffTaskSpace()
let handoffCode = ''
try {
  await page.request('${origin}/echo')
} catch (error) {
  handoffCode = error.error_code || error.message
}
cliLog(JSON.stringify({
  taskId: task.id,
  profileMode: task.profileMode,
  setCookieHidden: setCookie.header('set-cookie') === null,
  cookieReused: absoluteBody.cookie.includes('ufo_profile_request=space-a'),
  relativeResolved: relativeBody.path === '/echo',
  chromiumUa: absoluteBody.userAgent.includes('Chrome/'),
  chromiumLanguage: absoluteBody.acceptLanguage.includes('zh-CN'),
  corsIndependent: relative.ok,
  busyRendererIndependent: busy.ok && busyDurationMs < 1000,
  redirectFollowed: redirected.status === 200 && redirectedBody.path === '/echo',
  redirectErrorCode,
  sensitiveRequestWorked:
    sensitiveEcho.authorization === sensitiveAuth &&
    sensitiveEcho.body.includes(sensitiveBody),
  timeoutCode,
  sizeCode,
  headerCode,
  handoffCode,
  eventCount: events.events.length,
  eventRedacted:
    !eventText.includes(sensitiveAuth) &&
    !eventText.includes(sensitiveBody) &&
    !eventText.includes('forbidden=secret')
}))
`),
  );
  firstTaskId = first.taskId;
  assert.equal(first.profileMode, "temporary");
  assert.equal(first.setCookieHidden, true);
  assert.equal(first.cookieReused, true);
  assert.equal(first.relativeResolved, true);
  assert.equal(first.chromiumUa, true);
  assert.equal(first.chromiumLanguage, true);
  assert.equal(first.corsIndependent, true);
  assert.equal(first.busyRendererIndependent, true);
  assert.equal(first.redirectFollowed, true);
  assert.match(first.redirectErrorCode, /EGO_PROFILE_REQUEST_FAILED/);
  assert.equal(first.sensitiveRequestWorked, true);
  assert.match(first.timeoutCode, /EGO_PROFILE_REQUEST_TIMEOUT/);
  assert.match(first.sizeCode, /EGO_PROFILE_REQUEST_RESPONSE_TOO_LARGE/);
  assert.match(first.headerCode, /EGO_PROFILE_REQUEST_FORBIDDEN_HEADER/);
  assert.match(first.handoffCode, /EGO_TASK_SPACE_USER_IN_CONTROL/);
  assert.equal(first.eventRedacted, true);
  assert.ok(first.eventCount >= 10);
  const persistedEvents = await waitForText(
    join(testRoot, "user-data", "Agent Events", `space-${firstTaskId}.json`),
    3_000,
  );
  assert.equal(persistedEvents.includes(sensitiveAuth), false);
  assert.equal(persistedEvents.includes(sensitiveBody), false);
  assert.equal(persistedEvents.includes("forbidden=secret"), false);

  const second = JSON.parse(
    await runCli(`
const task = await bootstrapTaskSpace({
  name: 'Profile Request B',
  profileId: 'Temporary'
})
const response = await fetch.profile('${origin}/echo')
const body = await response.json()
cliLog(JSON.stringify({
  taskId: task.id,
  profileMode: task.profileMode,
  isolated: !body.cookie.includes('ufo_profile_request=space-a')
}))
`),
  );
  secondTaskId = second.taskId;
  assert.equal(second.profileMode, "temporary");
  assert.equal(second.isolated, true);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        noRendererRequiredForAbsoluteRequest: true,
        cookieWritebackAndReuse: first.cookieReused,
        temporaryProfileIsolation: second.isolated,
        relativeUrl: first.relativeResolved,
        corsIndependent: first.corsIndependent,
        busyRendererIndependent: first.busyRendererIndependent,
        chromiumIdentity: {
          userAgent: first.chromiumUa,
          acceptLanguage: first.chromiumLanguage,
        },
        limits: {
          timeout: first.timeoutCode,
          responseBody: first.sizeCode,
          forbiddenHeader: first.headerCode,
        },
        ownershipBlockedAfterHandoff: first.handoffCode,
        eventRedacted: first.eventRedacted,
        persistedEventRedacted: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (firstTaskId && electron) {
    await runCli(`
await useTaskSpace(${Number(firstTaskId)})
await takeOverTaskSpace()
await completeTaskSpace(${Number(firstTaskId)}, { keep: false })
`).catch(() => undefined);
  }
  if (secondTaskId && electron) {
    await runCli(`
await useTaskSpace(${Number(secondTaskId)})
await completeTaskSpace(${Number(secondTaskId)}, { keep: false })
`).catch(() => undefined);
  }
  await stopElectron().catch(() => undefined);
  await new Promise((resolve) => fixture.close(() => resolve()));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) reject(new Error("fixture body too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
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

async function waitForText(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  throw new Error(`timed out waiting for ${path}: ${String(lastError)}`);
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
