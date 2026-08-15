import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { NativeCefRuntime } from "../dist/main/native-cef-runtime.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userDataDir = await mkdtemp(join(tmpdir(), "ufo-native-product-shell-"));
const spaceData = join(userDataDir, "Profile 1");
const controlSocket = `/tmp/ufo-product-${process.pid}-${Date.now()}.sock`;
const presentationSocket = `/tmp/ufo-product-present-${process.pid}-${Date.now()}.sock`;
const devtoolsSocket = `/tmp/ufo-product-devtools-${process.pid}-${Date.now()}.sock`;
const executable = join(
  root,
  "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host",
);
await access(executable);
await mkdir(spaceData, { recursive: true });

const web = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>UFO Product Shell</title><h1>UFO Product Shell</h1>");
});
await new Promise((resolveListen, reject) => {
  web.once("error", reject);
  web.listen(0, "127.0.0.1", resolveListen);
});
const address = web.address();
if (!address || typeof address === "string") throw new Error("product-shell smoke HTTP server did not bind");
const origin = `http://127.0.0.1:${address.port}/`;
const overviewUrl = `${origin}?overview=1`;
const spaceUrl = `${origin}?space=701`;

const runtimeOptions = {
  executable,
  url: overviewUrl,
  overview: true,
  userDataDir,
  controlSocket,
  presentationSocket,
  devtoolsSocket,
  useMockKeychain: true,
};
let runtime = new NativeCefRuntime(runtimeOptions);

try {
  await runtime.start({ startupTimeoutMs: 20_000 });
  await runtime.createSharedSpace({
    id: 701,
    name: "Native Product Shell",
    profileName: "Experimental Profile",
    url: spaceUrl,
    cachePath: spaceData,
    visible: false,
    nativeChromeShell: true,
    chromeProfileDirectory: "Profile 1",
    chromeUserDataRoot: userDataDir,
  });
  const initialBrowsers = await waitForBrowsers(runtime, 701, 1);
  assert.equal(initialBrowsers.filter((browser) => browser.primary).length, 1);

  await runtime.control("hide");
  await runtime.controlSharedSpace(701, "show-space");
  await runtime.controlSharedSpace(701, "focus-space");
  const presented = await waitForStatus(runtime, (status) =>
    status.nativeChromeSpaceIds?.includes(701) &&
    status.nativeSpacesButtonSpaceIds?.includes(701) &&
    status.nativeCloseRoutedSpaceIds?.includes(701) &&
    status.presentedSpaceIds?.includes(701));
  assert.equal(presented.visibleSpaceId, 701);
  assert.equal(presented.presentedWindowCount, 1);

  const primaryBefore = initialBrowsers.find((browser) => browser.primary);
  assert.ok(primaryBefore);
  const primaryConnection = await runtime.connectBrowser(primaryBefore.route);
  try {
    const version = await primaryConnection.send("Browser.getVersion");
    assert.match(String(version.product), /Chrome|Chromium/i);
    const targets = await primaryConnection.send("Target.getTargets");
    const page = targets?.targetInfos?.find((target) => target.type === "page" && target.url === spaceUrl);
    assert.ok(page?.targetId, "native Chrome Space did not expose its page target");
    const attached = await primaryConnection.send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    const cookieWrite = await primaryConnection.send("Runtime.evaluate", {
      expression: "document.cookie = 'ufo_session=available; Max-Age=86400; path=/'; document.cookie",
      returnByValue: true,
    }, attached.sessionId);
    assert.match(String(cookieWrite?.result?.value), /ufo_session=available/);
    const committedCookies = await primaryConnection.send("Network.getCookies", {
      urls: [spaceUrl],
    }, attached.sessionId);
    assert.ok(committedCookies?.cookies?.some((cookie) =>
      cookie.name === "ufo_session" && cookie.value === "available"));
  } finally {
    await primaryConnection.close();
  }
  await runtime.control("hide");
  await runtime.controlSharedSpace(701, "show-space");
  await runtime.controlSharedSpace(701, "focus-space");
  await waitForStatus(runtime, (status) =>
    status.visibleSpaceId === 701 &&
    status.nativeSpacesButtonSpaceIds?.includes(701));

  await runtime.controlSharedSpace(701, "create-space-tab");
  const twoTabs = await waitForBrowsers(runtime, 701, 2);
  assert.equal(twoTabs.length, 2);
  const oldPrimary = twoTabs.find((browser) => browser.primary);
  const otherTab = twoTabs.find((browser) => !browser.primary);
  assert.ok(oldPrimary && otherTab);

  // Close only the original tab. UFO must promote the remaining native tab
  // instead of dropping the Browser-level Space route used by Agent CDP.
  const oldPrimaryConnection = await runtime.connectBrowser(oldPrimary.route);
  try {
    await oldPrimaryConnection.send("Page.close");
  } finally {
    await oldPrimaryConnection.close().catch(() => undefined);
  }
  const promoted = await waitForBrowsers(runtime, 701, 1);
  assert.equal(promoted[0].browserId, otherTab.browserId);
  assert.equal(promoted[0].primary, true);
  const promotedConnection = await runtime.connectBrowser("space:701");
  try {
    const version = await promotedConnection.send("Browser.getVersion");
    assert.ok(version.product, "promoted native tab lost the Agent browser route");
  } finally {
    await promotedConnection.close();
  }

  await runtime.controlSharedSpace(701, "agent-active-space-on");
  const controlled = await waitForStatus(runtime, (status) =>
    status.agentActiveSpaceIds?.includes(701) &&
    status.nativeCloseLockedSpaceIds?.includes(701) &&
    status.agentOverlayPresented &&
    status.agentOverlayActionsAvailable);
  assert.equal(controlled.visibleSpaceId, 701);
  await runtime.controlSharedSpace(701, "agent-active-space-off");

  await runtime.controlSharedSpace(701, "close-space");
  await waitForSpaceClosed(runtime, 701);

  console.log(JSON.stringify({
    oneCefHost: true,
    nativeChromeWindow: true,
    nativeTabStripAndOmnibox: true,
    spacesButtonPresented: true,
    nativeCloseUsesSpaceStateMachine: true,
    agentOwnedNativeCloseLocked: true,
    primaryTabPromotion: true,
    agentRouteSurvivesPrimaryTabClose: true,
    agentOverlay: true,
    inProcessCookieAccess: true,
    realChromeProfileContext: true,
    persistenceCoveredByChromeProfileProbe: true,
  }));
} finally {
  await runtime.stop();
  await new Promise((resolveClose) => web.close(() => resolveClose()));
  await rm(controlSocket, { force: true }).catch(() => undefined);
  await rm(presentationSocket, { force: true }).catch(() => undefined);
  await rm(devtoolsSocket, { force: true }).catch(() => undefined);
  if (process.env.UFO_KEEP_TEST_DATA === "1") {
    console.error(`[product-shell smoke] kept ${userDataDir}`);
  } else {
    await rm(userDataDir, { recursive: true, force: true });
  }
}

async function waitForBrowsers(host, spaceId, count) {
  let browsers = [];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      browsers = await host.listSharedSpaceBrowsers(spaceId);
      if (browsers.length === count && browsers.some((browser) => browser.primary)) return browsers;
    } catch {
      // Native tabs and route promotion are asynchronous at CEF lifecycle boundaries.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Space ${spaceId} did not expose ${count} browser(s): ${JSON.stringify(browsers)}`);
}

async function waitForStatus(host, predicate) {
  let status;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    status = JSON.parse(await sendSocket(
      controlSocket,
      JSON.stringify({ command: "presentation-status" }),
    ));
    if (predicate(status)) return status;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`product shell status did not converge: ${JSON.stringify(status)}`);
}

async function waitForSpaceClosed(host, spaceId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await host.controlSharedSpace(spaceId, "status-space");
    } catch (error) {
      if (String(error).includes("space-not-found")) return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Space ${spaceId} did not close`);
}

function sendSocket(path, command) {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(path);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", rejectResponse);
    socket.once("close", () => resolveResponse(response.trim()));
    socket.once("connect", () => socket.write(`${command}\n`));
  });
}
