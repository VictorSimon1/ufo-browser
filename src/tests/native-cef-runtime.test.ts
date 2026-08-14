import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNativeCefArgs,
  NativeCefPrivateConnection,
  NativeCefRuntime,
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
