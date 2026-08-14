import test from "node:test";
import assert from "node:assert/strict";
import { buildNativeCefArgs, NativeCefRuntime } from "../main/native-cef-runtime.js";

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
    userDataDir: "/tmp/ufo-space-data",
    chromeShell: true,
  });
  assert.ok(args.includes("--chrome-shell"));
  assert.ok(!args.includes("--overview"));
  assert.ok(args.includes("--devtools-socket=/tmp/ufo-space-devtools.sock"));
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
