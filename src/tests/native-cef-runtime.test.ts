import test from "node:test";
import assert from "node:assert/strict";
import { NativeCefRuntime } from "../main/native-cef-runtime.js";

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
