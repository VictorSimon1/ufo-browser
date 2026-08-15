import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { NativeCefApplication } from "../dist/main/native-cef-application.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userDataDir = await mkdtemp(join(tmpdir(), "ufo-native-overlay-smoke-"));
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
const controlSocket = `/tmp/ufo-overlay-control-${process.pid}.sock`;
const presentationSocket = `/tmp/ufo-overlay-actions-${process.pid}.sock`;
await access(executable);

const fixture = createServer((_request, response) => {
  response.end(`<!doctype html><title>Native Overlay</title>
    <button id="increment" data-count="0"
      onclick="this.dataset.count=String(Number(this.dataset.count)+1)">Increment</button>`);
});
await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", resolveListen));
const fixturePort = fixture.address().port;

const app = new NativeCefApplication({
  userDataDir,
  cefExecutable: executable,
  useMockKeychain: true,
  env: {
    UFO_BROWSER_SOURCE_PARTITIONS: join(userDataDir, "NoSource"),
    UFO_CEF_PRIVATE_BRIDGE: "1",
    UFO_BROWSER_OVERVIEW_CONTROL_SOCKET: controlSocket,
    UFO_BROWSER_PRESENTATION_SOCKET: presentationSocket,
  },
});

try {
  await app.start();
  const socket = join(userDataDir, "ufo-browser.sock");
  const overview = JSON.parse(await readFile(join(userDataDir, "overview.json"), "utf8"));
  const created = await runCli(socket, `
    const task = await bootstrapTaskSpace({
      name: 'native persistent overlay',
      url: 'http://127.0.0.1:${fixturePort}/'
    })
    cliLog(task.id)
  `);
  const spaceId = Number(created.trim().split(/\s+/).at(-1));
  assert.ok(Number.isInteger(spaceId) && spaceId > 0, `invalid Space id: ${created}`);

  const spacesUrl = `http://${overview.host}:${overview.port}/api/spaces`;
  const open = await fetch(`${spacesUrl}/${spaceId}/open`, { method: "POST" }).then((response) => response.json());
  assert.equal(open.ok, true);
  await delay(750);

  // The bootstrap CLI has already exited. Ownership, not socket lifetime,
  // must keep the outer AppKit control overlay active.
  const afterDisconnect = await presentationStatus(controlSocket);
  assert.equal(afterDisconnect.agentOverlayPresented, true, JSON.stringify(afterDisconnect));
  assert.equal(afterDisconnect.agentOverlayActionsAvailable, true, JSON.stringify(afterDisconnect));
  assert.ok(afterDisconnect.agentActiveSpaceIds.includes(spaceId));
  assert.equal(await sendSocket(controlSocket, `${JSON.stringify({
    command: "agent-overlay-state",
    spaceId,
    title: "Native overlay smoke",
    detail: "Agent 正在测试页面",
  })}\n`), "ok\n");
  assert.equal(await sendSocket(controlSocket, `${JSON.stringify({
    command: "agent-pointer-space",
    spaceId,
    x: 180,
    y: 160,
    label: "正在浏览网页",
  })}\n`), "ok\n");

  // The AppKit panel is outside the CEF compositor. Agent CDP input and page
  // screenshots must continue to work while the human-facing overlay exists.
  const agentResult = JSON.parse((await runCli(socket, `
    await useTaskSpace(${spaceId})
    await click('#increment', { label: 'overlay input isolation' })
    const count = await js("document.querySelector('#increment').dataset.count")
    const screenshot = await captureScreenshot()
    cliLog(JSON.stringify({ count, screenshot }))
  `)).trim().split("\n").at(-1));
  assert.equal(agentResult.count, "1");
  assert.equal(typeof agentResult.screenshot, "string");
  await access(agentResult.screenshot);
  await delay(250);
  assert.equal((await presentationStatus(controlSocket)).agentOverlayPresented, true);

  await sendPresentationCommand(presentationSocket, {
    command: "take-over-space",
    spaceId,
  });
  await waitFor(async () => !(await presentationStatus(controlSocket)).agentOverlayPresented);
  let space = await readSpace(spacesUrl, spaceId);
  assert.equal(space.ownership, "user");
  assert.equal(space.lifecycle, "active");

  await runCli(socket, `
    await takeOverTaskSpace(${spaceId})
    cliLog('claimed')
  `);
  await waitFor(async () => (await presentationStatus(controlSocket)).agentOverlayPresented);
  await sendPresentationCommand(presentationSocket, {
    command: "terminate-space",
    spaceId,
  });
  await waitFor(async () => !(await presentationStatus(controlSocket)).agentOverlayPresented);
  space = await readSpace(spacesUrl, spaceId);
  assert.equal(space.ownership, "user");
  assert.equal(space.lifecycle, "completed");

  console.log(JSON.stringify({
    ownershipPersistsAfterCliExit: true,
    nativeActions: ["take-over-space", "terminate-space"],
    agentInputBehindOverlay: true,
    agentScreenshotBehindOverlay: true,
    finalLifecycle: space.lifecycle,
  }));
} finally {
  await app.stop().catch(() => undefined);
  await new Promise((resolveClose) => fixture.close(resolveClose));
  await rm(controlSocket, { force: true }).catch(() => undefined);
  await rm(presentationSocket, { force: true }).catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
}

function runCli(socket, source) {
  return new Promise((resolveOutput, reject) => {
    const cli = spawn(join(root, "dist/bin/ufo-browser"), ["nodejs"], {
      cwd: root,
      env: { ...process.env, UFO_BROWSER_SOCKET: socket },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    cli.stdout.setEncoding("utf8");
    cli.stderr.setEncoding("utf8");
    cli.stdout.on("data", (chunk) => { stdout += chunk; });
    cli.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => cli.kill("SIGTERM"), 30_000);
    cli.once("error", reject);
    cli.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveOutput(stdout);
      else reject(new Error(`Native overlay CLI failed (${code})\n${stdout}\n${stderr}`));
    });
    cli.stdin.end(source);
  });
}

function presentationStatus(path) {
  return sendSocket(path, `${JSON.stringify({ command: "presentation-status" })}\n`)
    .then((body) => JSON.parse(body.trim()));
}

function sendPresentationCommand(path, command) {
  return sendSocket(path, `${JSON.stringify(command)}\n`).then((body) => {
    assert.equal(body, "ok\n");
  });
}

function sendSocket(path, payload) {
  return new Promise((resolveBody, reject) => {
    const socket = createConnection(path);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { body += chunk; });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(payload));
    socket.once("close", () => resolveBody(body));
  });
}

async function readSpace(spacesUrl, spaceId) {
  const result = await fetch(spacesUrl).then((response) => response.json());
  const space = result.spaces.find((candidate) => candidate.id === spaceId);
  assert.ok(space, `Space ${spaceId} missing: ${JSON.stringify(result)}`);
  return space;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error("condition did not become true");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
