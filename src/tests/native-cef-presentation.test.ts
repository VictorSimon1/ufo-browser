import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCefPresentationCoordinator } from "../main/native-cef-presentation.js";

test("native presentation opens one Space and hides Overview", async () => {
  const calls: string[] = [];
  const manager = {
    presentSpace: async (id: number) => { calls.push(`present:${id}`); },
    hideRunningSpaces: async () => { calls.push("hide-spaces"); },
    closeSpace: async () => true,
    showSpace: async () => {},
  } as any;
  const overview = {
    hideWindow: async () => { calls.push("hide-overview"); },
    showWindow: async () => { calls.push("show-overview"); },
    focusWindow: async () => { calls.push("focus-overview"); },
  } as any;
  const coordinator = new NativeCefPresentationCoordinator(manager, overview);
  await coordinator.openSpace(7);
  assert.deepEqual(calls, ["present:7", "hide-overview"]);
  assert.deepEqual(coordinator.getState(), { kind: "space", spaceId: 7 });
});

test("closing the visible native Space returns to Overview once", async () => {
  const calls: string[] = [];
  const manager = {
    presentSpace: async () => {},
    hideRunningSpaces: async () => { calls.push("hide-spaces"); },
    closeSpace: async (id: number) => { calls.push(`close:${id}`); return true; },
    showSpace: async () => {},
  } as any;
  const overview = {
    hideWindow: async () => {},
    showWindow: async () => { calls.push("show-overview"); },
    focusWindow: async () => { calls.push("focus-overview"); },
  } as any;
  const coordinator = new NativeCefPresentationCoordinator(manager, overview);
  await coordinator.openSpace(3);
  calls.length = 0;
  await coordinator.closeSpace(3);
  assert.deepEqual(calls, ["close:3", "hide-spaces", "show-overview", "focus-overview"]);
  assert.deepEqual(coordinator.getState(), { kind: "overview" });
});

test("the native Spaces button routes through the presentation coordinator", async () => {
  const calls: string[] = [];
  const manager = {
    presentSpace: async () => {},
    hideRunningSpaces: async () => { calls.push("hide-spaces"); },
    closeSpace: async () => false,
    showSpace: async () => {},
  } as any;
  const overview = {
    hideWindow: async () => {},
    showWindow: async () => { calls.push("show-overview"); },
    focusWindow: async () => { calls.push("focus-overview"); },
  } as any;
  const root = await mkdtemp(join(tmpdir(), "ufo-presentation-socket-"));
  const socketPath = join(root, "presentation.sock");
  const coordinator = new NativeCefPresentationCoordinator(manager, overview, socketPath);
  try {
    await coordinator.start();
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let body = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { body += chunk; });
      socket.once("error", reject);
      socket.once("connect", () => socket.write("show-overview\n"));
      socket.once("close", () => resolve(body));
    });
    assert.equal(response, "ok\n");
    assert.deepEqual(calls, ["hide-spaces", "show-overview", "focus-overview"]);
  } finally {
    await coordinator.stop();
    await rm(root, { recursive: true, force: true });
  }
});
