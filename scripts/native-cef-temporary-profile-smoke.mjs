import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { NativeCefApplication } from "../dist/main/native-cef-application.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userDataDir = await mkdtemp(join(tmpdir(), "ufo-native-temporary-profile-"));
const executable = join(
  root,
  "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host",
);
const controlSocket = `/tmp/ufo-temp-control-${process.pid}.sock`;
const presentationSocket = `/tmp/ufo-temp-present-${process.pid}.sock`;
await access(executable);

const fixture = createServer((request, response) => {
  if (request.url?.startsWith("/sw.js")) {
    response.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "service-worker-allowed": "/",
      "cache-control": "no-store",
    });
    response.end("self.addEventListener('fetch', () => {});");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end("<!doctype html><title>Native Temporary Profile</title><h1>Temporary Profile</h1>");
});
await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", resolveListen));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;

const appOptions = {
  userDataDir,
  cefExecutable: executable,
  useMockKeychain: true,
  env: {
    UFO_BROWSER_SOURCE_PARTITIONS: join(userDataDir, "NoSource"),
    UFO_CEF_PRIVATE_BRIDGE: "1",
    UFO_BROWSER_OVERVIEW_CONTROL_SOCKET: controlSocket,
    UFO_BROWSER_PRESENTATION_SOCKET: presentationSocket,
  },
};
let app = new NativeCefApplication(appOptions);

const seedStateExpression = String.raw`(async () => {
  document.cookie = 'ufo_temp=alpha; path=/'
  localStorage.setItem('ufo-temp', 'alpha')
  sessionStorage.setItem('ufo-temp', 'alpha')
  const cache = await caches.open('ufo-temp-cache')
  await cache.put('/ufo-temp-value', new Response('alpha'))
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('ufo-temp-db', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('values')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('values', 'readwrite')
      transaction.objectStore('values').put('alpha', 'state')
      transaction.oncomplete = () => { db.close(); resolve() }
      transaction.onerror = () => reject(transaction.error)
    }
  })
  const registration = await navigator.serviceWorker.register('/sw.js?space=alpha', { scope: '/' })
  await navigator.serviceWorker.ready
  return { scope: registration.scope }
})()`;

const readStateExpression = String.raw`(async () => {
  const cacheNames = await caches.keys()
  const registrations = await navigator.serviceWorker.getRegistrations()
  const databaseNames = typeof indexedDB.databases === 'function'
    ? (await indexedDB.databases()).map((entry) => entry.name)
    : []
  return {
    cookie: document.cookie.includes('ufo_temp=alpha'),
    localStorage: localStorage.getItem('ufo-temp'),
    sessionStorage: sessionStorage.getItem('ufo-temp'),
    cache: cacheNames.includes('ufo-temp-cache'),
    indexedDB: databaseNames.includes('ufo-temp-db'),
    serviceWorker: registrations.some((entry) => entry.active?.scriptURL.includes('space=alpha')),
  }
})()`;

try {
  await app.start();
  const socket = join(userDataDir, "ufo-browser.sock");
  const initialOverview = JSON.parse(await readFile(join(userDataDir, "overview.json"), "utf8"));
  const overviewProfiles = await fetch(`${initialOverview.url}api/profiles`)
    .then((response) => response.json());
  assert.ok(
    overviewProfiles.profiles?.some((profile) =>
      profile.id === "temporary" && profile.ephemeral === true),
    JSON.stringify(overviewProfiles),
  );
  const profiles = JSON.parse((await runCli(socket, `
    cliLog(JSON.stringify(await listProfiles()))
  `)).trim().split("\n").at(-1));
  assert.ok(
    profiles.profiles?.some((profile) =>
      profile.id === "Temporary" && profile.name === "临时 Profile"),
    JSON.stringify(profiles),
  );

  const result = JSON.parse((await runCli(socket, `
    const temporaryA = await bootstrapTaskSpace({
      name: 'native temporary A',
      profileId: 'Temporary',
      url: ${JSON.stringify(fixtureUrl)},
    })
    const seededA = await js(${JSON.stringify(seedStateExpression)})
    const temporaryB = await bootstrapTaskSpace({
      name: 'native temporary B',
      profileId: 'Temporary',
      url: ${JSON.stringify(fixtureUrl)},
    })
    const isolatedB = await js(${JSON.stringify(readStateExpression)})
    await useTaskSpace(temporaryA.id)
    const retainedA = await js(${JSON.stringify(readStateExpression)})
    cliLog(JSON.stringify({ temporaryA, temporaryB, seededA, isolatedB, retainedA }))
  `)).trim().split("\n").at(-1));

  assert.equal(result.temporaryA.profileMode, "temporary");
  assert.equal(result.temporaryB.profileMode, "temporary");
  assert.notEqual(result.temporaryA.sessionScopeId, result.temporaryB.sessionScopeId);
  assert.deepEqual(result.isolatedB, {
    cookie: false,
    localStorage: null,
    sessionStorage: null,
    cache: false,
    indexedDB: false,
    serviceWorker: false,
  });
  assert.deepEqual(result.retainedA, {
    cookie: true,
    localStorage: "alpha",
    sessionStorage: "alpha",
    cache: true,
    indexedDB: true,
    serviceWorker: true,
  });

  const presentation = await presentationStatus(controlSocket);
  for (const spaceId of [result.temporaryA.id, result.temporaryB.id]) {
    assert.ok(presentation.nativeChromeSpaceIds.includes(spaceId), JSON.stringify(presentation));
    assert.ok(presentation.agentActiveSpaceIds.includes(spaceId), JSON.stringify(presentation));
  }

  const overview = JSON.parse(await readFile(join(userDataDir, "overview.json"), "utf8"));
  const spacesUrl = `${overview.url}api/spaces`;
  const opened = await fetch(`${spacesUrl}/${result.temporaryA.id}/open`, {
    method: "POST",
  }).then((response) => response.json());
  assert.equal(opened.ok, true, JSON.stringify(opened));
  await delay(500);
  const controlledTemporary = await presentationStatus(controlSocket);
  assert.equal(controlledTemporary.visibleSpaceId, result.temporaryA.id);
  assert.equal(controlledTemporary.agentOverlayPresented, true);
  assert.equal(controlledTemporary.agentOverlayActionsAvailable, true);
  assert.ok(
    controlledTemporary.controllerMountedSpaceIds.includes(result.temporaryA.id),
    JSON.stringify(controlledTemporary),
  );
  const controlledAgent = JSON.parse((await runCli(socket, `
    await useTaskSpace(${result.temporaryA.id})
    const retained = await js(${JSON.stringify(readStateExpression)})
    const screenshot = await captureScreenshot()
    cliLog(JSON.stringify({ retained, screenshot }))
  `)).trim().split("\n").at(-1));
  assert.deepEqual(controlledAgent.retained, result.retainedA);
  assert.equal(typeof controlledAgent.screenshot, "string");
  await access(controlledAgent.screenshot);

  for (const spaceId of [result.temporaryB.id, result.temporaryA.id]) {
    const closed = await fetch(`${spacesUrl}/${spaceId}/close`, { method: "POST" })
      .then((response) => response.json());
    assert.equal(closed.ok, true, JSON.stringify(closed));
  }
  const afterClose = await fetch(spacesUrl).then((response) => response.json());
  assert.equal(afterClose.spaces.some((space) => space.profileMode === "temporary"), false);
  await assert.rejects(
    access(join(userDataDir, "Native Spaces", `space-${result.temporaryA.id}`)),
  );
  await assert.rejects(
    access(join(userDataDir, "Native Spaces", `space-${result.temporaryB.id}`)),
  );

  await app.stop();
  app = new NativeCefApplication(appOptions);
  await app.start();
  const restartedOverview = JSON.parse(await readFile(join(userDataDir, "overview.json"), "utf8"));
  const restartedSpaces = await fetch(`${restartedOverview.url}api/spaces`)
    .then((response) => response.json());
  assert.equal(
    restartedSpaces.spaces.some((space) => space.profileMode === "temporary"),
    false,
  );

  console.log(JSON.stringify({
    nativeChromeTemporaryProfiles: true,
    overviewCanCreateTemporaryProfile: true,
    uniqueOtrContextPerSpace: true,
    cookieIsolated: true,
    localStorageIsolated: true,
    sessionStorageIsolated: true,
    indexedDbIsolated: true,
    cacheStorageIsolated: true,
    serviceWorkerIsolated: true,
    agentOverlayPreserved: true,
    agentScreenshotBehindOverlay: true,
    stagingDirectoriesRemoved: true,
    restartDoesNotRestoreTemporarySpaces: true,
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
    const timeout = setTimeout(() => cli.kill("SIGTERM"), 60_000);
    cli.once("error", reject);
    cli.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveOutput(stdout);
      else reject(new Error(`Native Temporary Profile CLI failed (${code})\n${stdout}\n${stderr}`));
    });
    cli.stdin.end(source);
  });
}

function presentationStatus(path) {
  return sendSocket(path, `${JSON.stringify({ command: "presentation-status" })}\n`)
    .then((body) => JSON.parse(body.trim()));
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
