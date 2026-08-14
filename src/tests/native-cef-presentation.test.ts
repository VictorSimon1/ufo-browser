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

test("native overlay takeover revokes the Agent lease and keeps the Space presented", async () => {
  const calls: string[] = [];
  const manager = {
    presentSpace: async () => {},
    hideRunningSpaces: async () => {},
    closeSpace: async () => false,
    showSpace: async () => {},
    setOwnership: async (id: number, ownership: string, lifecycle: string) => {
      calls.push(`ownership:${id}:${ownership}:${lifecycle}`);
    },
    setLifecycle: async () => {},
  } as any;
  const overview = {
    hideWindow: async () => {},
    showWindow: async () => {},
    focusWindow: async () => {},
  } as any;
  const root = await mkdtemp(join(tmpdir(), "ufo-overlay-takeover-"));
  const socketPath = join(root, "presentation.sock");
  const coordinator = new NativeCefPresentationCoordinator(manager, overview, socketPath);
  coordinator.setAgentControl({ revokeSpace: (id) => calls.push(`revoke:${id}`) });
  try {
    await coordinator.start();
    await coordinator.openSpace(9);
    calls.length = 0;
    const response = await sendPresentationCommand(socketPath, {
      command: "take-over-space",
      spaceId: 9,
    });
    assert.equal(response, "ok\n");
    assert.deepEqual(calls, ["revoke:9", "ownership:9:user:active"]);
    assert.deepEqual(coordinator.getState(), { kind: "space", spaceId: 9 });
  } finally {
    await coordinator.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("native overlay termination revokes the Agent lease without closing the Space", async () => {
  const calls: string[] = [];
  const manager = {
    presentSpace: async () => {},
    hideRunningSpaces: async () => {},
    closeSpace: async () => false,
    showSpace: async () => {},
    setOwnership: async () => {},
    setLifecycle: async (id: number, lifecycle: string) => {
      calls.push(`lifecycle:${id}:${lifecycle}`);
    },
  } as any;
  const overview = {
    hideWindow: async () => {},
    showWindow: async () => {},
    focusWindow: async () => {},
  } as any;
  const root = await mkdtemp(join(tmpdir(), "ufo-overlay-terminate-"));
  const socketPath = join(root, "presentation.sock");
  const coordinator = new NativeCefPresentationCoordinator(manager, overview, socketPath);
  coordinator.setAgentControl({ revokeSpace: (id) => calls.push(`revoke:${id}`) });
  try {
    await coordinator.start();
    await coordinator.openSpace(11);
    calls.length = 0;
    const response = await sendPresentationCommand(socketPath, {
      command: "terminate-space",
      spaceId: 11,
    });
    assert.equal(response, "ok\n");
    assert.deepEqual(calls, ["revoke:11", "lifecycle:11:completed"]);
    assert.deepEqual(coordinator.getState(), { kind: "space", spaceId: 11 });
  } finally {
    await coordinator.stop();
    await rm(root, { recursive: true, force: true });
  }
});

function sendPresentationCommand(path: string, command: unknown) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(path);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { body += chunk; });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.once("close", () => resolve(body));
  });
}
