import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ElectronCdpTransport } from "../main/cdp-transport.js";

class FakeDebugger extends EventEmitter {
  attached = false;
  commands: Array<{ method: string; params: any; sessionId?: string }> = [];
  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  async sendCommand(method: string, params: any = {}, sessionId?: string) {
    this.commands.push({ method, params, sessionId });
    return { method, params, sessionId };
  }
  off(event: "message", listener: (...args: any[]) => void) {
    super.off(event, listener);
    return this;
  }
}

test("ElectronCdpTransport preserves CDP sessions and forwards events", async () => {
  const debuggerApi = new FakeDebugger();
  const transport = new ElectronCdpTransport(debuggerApi as any);
  const events: any[] = [];
  const unsubscribe = transport.onEvent((event) => events.push(event));
  const result = await transport.sendCommand("Runtime.evaluate", { expression: "1" }, "session-1");
  assert.equal(result.sessionId, "session-1");
  assert.deepEqual(debuggerApi.commands[0], {
    method: "Runtime.evaluate",
    params: { expression: "1" },
    sessionId: "session-1",
  });
  debuggerApi.emit("message", {}, "Page.loadEventFired", { frameId: "root" }, "session-1");
  assert.deepEqual(events, [{ method: "Page.loadEventFired", params: { frameId: "root" }, sessionId: "session-1" }]);
  unsubscribe();
  await transport.close();
  assert.equal(debuggerApi.listenerCount("message"), 0);
});

