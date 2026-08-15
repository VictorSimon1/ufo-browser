import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNativeCefArgs,
  collectNativeFrameIds,
  collectNativeDomFrameIds,
  NativeCefPrivateConnection,
  NativeCefRuntime,
  prioritizeNativeSpaceBrowsers,
} from "../main/native-cef-runtime.js";

test("NativeCefRuntime starts with a deterministic development port", async () => {
  const runtime = new NativeCefRuntime({ port: 9333 });
  assert.equal(runtime.isRunning(), false);
  assert.equal(runtime.getPort(), undefined);
  await assert.rejects(() => runtime.version(), /not started/);
});

test("NativeCefRuntime rejects invalid DevTools ports before spawning", async () => {
  const runtime = new NativeCefRuntime({
    executable: "/definitely/missing/ufo-cef-host",
    port: 80,
  });
  await assert.rejects(() => runtime.start(), /Invalid Native CEF DevTools port/);
});

test("NativeCefRuntime adds development-only control and mock keychain switches", async () => {
  const runtime = new NativeCefRuntime({
    executable: "/definitely/missing/ufo-cef-host",
    port: 9333,
    controlSocket: "/tmp/ufo-control.sock",
    useMockKeychain: true,
  });
  await assert.rejects(() => runtime.start(), /Native CEF executable not found/);
});

test("Native CEF launches human-facing Spaces with the full Chrome shell", () => {
  const args = buildNativeCefArgs({
    url: "https://example.com/",
    devtoolsSocket: "/tmp/ufo-space-devtools.sock",
    controlSocket: "/tmp/ufo-space-control.sock",
    presentationSocket: "/tmp/ufo-presentation.sock",
    userDataDir: "/tmp/ufo-space-data",
    chromeShell: true,
    sharedSpaceManifest: "/tmp/ufo-shared-spaces.json",
  });
  assert.ok(args.includes("--chrome-shell"));
  assert.ok(!args.includes("--overview"));
  assert.ok(args.includes("--devtools-socket=/tmp/ufo-space-devtools.sock"));
  assert.ok(args.includes("--presentation-socket=/tmp/ufo-presentation.sock"));
  assert.ok(args.includes("--shared-space-manifest=/tmp/ufo-shared-spaces.json"));
});

test("Native Overview stays a management page without browser chrome", () => {
  const args = buildNativeCefArgs({
    url: "http://127.0.0.1:4321/",
    overview: true,
    chromeShell: true,
    port: 9333,
  });
  assert.ok(args.includes("--overview"));
  assert.ok(!args.includes("--chrome-shell"));
});

test("Native Chrome Profile probes select a safe real Profile directory", () => {
  const args = buildNativeCefArgs({
    url: "https://example.com/",
    nativeChromeProductShell: true,
    chromeProfileDirectory: "Profile 1",
    chromeProfileManagerProbe: true,
  });
  assert.ok(args.includes("--native-chrome-product-shell"));
  assert.ok(args.includes("--profile-directory=Profile 1"));
  assert.ok(args.includes("--chrome-profile-manager-probe"));
  assert.throws(() => buildNativeCefArgs({
    chromeProfileDirectory: "../escaped",
  }), /Invalid Chrome profile directory/);
});

test("Native Chrome Space targets always prefer the registered primary browser", () => {
  const browsers = prioritizeNativeSpaceBrowsers([
    { browserId: 2, route: "browser:2", primary: false, url: "https://example.com/" },
    { browserId: 3, route: "browser:3", primary: true, url: "https://example.com/" },
    { browserId: 4, route: "browser:4", primary: false, url: "https://popup.example/" },
  ]);
  assert.equal(browsers[0]?.browserId, 3);
  assert.deepEqual(new Set(browsers.map((browser) => browser.browserId)), new Set([2, 3, 4]));
});

test("Native Chrome frame routing collects only the exact Space frame tree", () => {
  assert.deepEqual(collectNativeFrameIds({
    frame: { id: "main-frame" },
    childFrames: [
      { frame: { id: "same-process-child" } },
      { frame: { id: "oopif-child" }, childFrames: [{ frame: { id: "nested" } }] },
    ],
  }), new Set(["main-frame", "same-process-child", "oopif-child", "nested"]));
});

test("Native Chrome DOM routing recovers OOPIF owner frame ids", () => {
  assert.deepEqual(collectNativeDomFrameIds({
    nodeName: "#document",
    children: [
      { nodeName: "IFRAME", frameId: "oopif-owner" },
      { nodeName: "DIV", shadowRoots: [{ frameId: "shadow-frame" }] },
    ],
  }), new Set(["oopif-owner", "shadow-frame"]));
});

test("private CEF bridge carries an explicit shared-host browser route", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-private-route-"));
  const socketPath = join(root, "devtools.sock");
  let received: any;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      received = JSON.parse(String(chunk).trim());
      socket.end(`${JSON.stringify({ id: received.id, result: { ok: true } })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const connection = new NativeCefPrivateConnection(
      socketPath,
      "browser",
      "browser:42",
    );
    assert.deepEqual(await connection.send("Browser.getVersion"), { ok: true });
    await connection.close();
    assert.equal(received.targetId, "browser");
    assert.equal(received.browserRoute, "browser:42");
    assert.equal(received.method, "Browser.getVersion");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("NativeCefRuntime attaches to the UFO main host without spawning it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-attached-host-"));
  const devtoolsSocket = join(root, "devtools.sock");
  const controlSocket = join(root, "control.sock");
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim());
      socket.end(`${JSON.stringify({
        id: request.id,
        result: {
          Browser: "UFO-Browser/attached",
          "Protocol-Version": "1.3",
          UserAgent: "UFO-Browser",
        },
      })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(devtoolsSocket, resolve);
    });
    const runtime = new NativeCefRuntime({ devtoolsSocket, controlSocket });
    const version = await runtime.attach({ startupTimeoutMs: 1_000 });
    assert.equal(version.Browser, "UFO-Browser/attached");
    assert.equal(runtime.isRunning(), true);
    await runtime.stop();
    assert.equal(runtime.isRunning(), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
