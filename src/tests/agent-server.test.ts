import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { AgentServer } from "../main/agent-server.js";
import { SpaceLeaseRegistry } from "../main/space-lease.js";
import { SpaceEventJournal } from "../main/space-event-journal.js";
import { AgentTraceService } from "../main/agent-trace.js";

test("selection does not claim a handed-off Space and explicit takeover can resume it", async () => {
  const root = await mkdtemp(join(tmpdir(), "x-browser-agent-server-"));
  const socketPath = join(root, "agent.sock");
  const space: any = {
    id: 7,
    name: "handoff",
    taskId: "handoff",
    lifecycle: "active",
    ownership: "agentDelegatedToUser",
    activeTabId: "page-1",
    tabs: [{ targetId: "page-1", title: "Page", url: "https://example.com" }],
  };
  let taskState: unknown;
  let pointer: unknown;
  let agentTab: unknown;
  const agentConnectionStates: boolean[] = [];
  const manager = {
    listSpaces: () => [structuredClone(space)],
    listProfiles: () => [
      {
        id: "Default",
        isDefault: true,
        name: "您的 UFO-Browser",
      },
    ],
    getSpaceOrThrow: (id: number) => {
      if (id !== space.id) throw new Error("task space not found");
      return space;
    },
    setOwnership: async (_id: number, ownership: string, lifecycle: string) => {
      space.ownership = ownership;
      space.lifecycle = lifecycle;
    },
    setAgentTaskState: async (_id: number, state: unknown) => {
      taskState = state;
    },
    showAgentPointer: (_id: number, x: number, y: number) => {
      pointer = { x, y };
    },
    createAgentTab: async (id: number, url: string) => {
      agentTab = { id, url };
      return { targetId: "page-1", url };
    },
    setAgentConnectionActive: (_id: number, active: boolean) => {
      agentConnectionStates.push(active);
    },
  };
  const broker = {
    registerConnection: () => undefined,
    removeConnection: () => undefined,
    releaseConnectionSpace: () => undefined,
  };
  const snapshot = {
    snapshot: async () => ({ content: "ok", refs: [] }),
    resolveHistoricalRef: async (spaceId: number, refId: number) => ({
      refId,
      backendNodeId: 81,
      role: "button",
      name: "Submit",
      loc: "role:button[name=\"Submit\"]",
      spaceId,
    }),
  };
  const server = new AgentServer(
    socketPath,
    manager as any,
    new SpaceLeaseRegistry(),
    snapshot as any,
    broker as any,
    "0.1.6",
    undefined,
    undefined,
    undefined,
    {
      request: async (spaceId: number, connectionId: string, url: string) => ({
        spaceId,
        connectionId: typeof connectionId,
        url,
        status: 200,
      }),
    } as any,
  );
  let socket: Socket | undefined;
  try {
    await server.listen();
    socket = await connectSocket(socketPath);

    const selected = await rpc(socket, 1, "useTaskSpace", [space.id]);
    assert.equal(selected.type, "rpc-result");
    assert.equal(selected.result.id, space.id);
    assert.equal(space.ownership, "agentDelegatedToUser");

    const blocked = await rpc(socket, 2, "snapshot", []);
    assert.equal(blocked.type, "rpc-error");
    assert.equal(blocked.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");

    const takenOver = await rpc(socket, 3, "takeOverTaskSpace", []);
    assert.deepEqual(takenOver.result, { done: true });
    assert.equal(space.ownership, "agent");

    const resumed = await rpc(socket, 4, "snapshot", []);
    assert.deepEqual(resumed.result, { content: "ok", refs: [] });

    const restoredRef = await rpc(socket, 41, "resolveRef", [21]);
    assert.deepEqual(restoredRef.result, {
      refId: 21,
      backendNodeId: 81,
      role: "button",
      name: "Submit",
      loc: "role:button[name=\"Submit\"]",
      spaceId: 7,
    });

    const invalidTab = await rpc(socket, 5, "createTab", []);
    assert.equal(invalidTab.type, "rpc-error");
    assert.match(invalidTab.error, /expects a string URL/);

    const labeled = await rpc(socket, 6, "setAgentTaskState", ["检查提交按钮"]);
    assert.deepEqual(labeled.result, { done: true });
    assert.equal(taskState, "检查提交按钮");

    const highlighted = await rpc(
      socket,
      7,
      "animationHighlightMouseToPosition",
      [320, 240],
    );
    assert.deepEqual(highlighted.result, { done: true });
    assert.deepEqual(pointer, { x: 320, y: 240 });

    const created = await rpc(socket, 8, "createTab", ["https://example.com/"]);
    assert.deepEqual(created.result, { targetId: "page-1" });
    assert.deepEqual(agentTab, { id: space.id, url: "https://example.com/" });

    const version = await rpc(socket, 9, "getBrowserVersion", []);
    assert.deepEqual(version.result, {
      currentVersion: "0.1.6",
      updateAvailable: false,
    });

    const profiles = await rpc(socket, 10, "listProfiles", []);
    assert.deepEqual(profiles.result, {
      profiles: [
        {
          id: "Default",
          isDefault: true,
          name: "您的 UFO-Browser",
        },
      ],
    });

    const requested = await rpc(socket, 101, "profileRequest", [
      "https://example.com/api/me",
      {},
    ]);
    assert.deepEqual(requested.result, {
      spaceId: 7,
      connectionId: "string",
      url: "https://example.com/api/me",
      status: 200,
    });

    const handedOff = await rpc(socket, 11, "handOffTaskSpace", []);
    assert.deepEqual(handedOff.result, { done: true });
    assert.deepEqual(agentConnectionStates, [true, false]);
    const blockedRequest = await rpc(socket, 12, "profileRequest", [
      "https://example.com/api/me",
      {},
    ]);
    assert.equal(blockedRequest.type, "rpc-error");
    assert.equal(blockedRequest.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
  } finally {
    socket?.destroy();
    await server.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent bootstrapTaskSpace verifies Profile selection and rejects legacy calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "x-browser-agent-profile-"));
  const socketPath = join(root, "agent.sock");
  const spaces = new Map<number, any>();
  const creations: Array<{ name: string; profileId?: string }> = [];
  const manager = {
    listSpaces: () => [...spaces.values()].map((space) => structuredClone(space)),
    listProfiles: () => [
      { id: "Temporary", isDefault: false, name: "临时 Profile" },
      { id: "Default", isDefault: true, name: "您的 UFO-Browser" },
    ],
    createSpace: async (name: string, _createdBy: string, profileId?: string) => {
      creations.push({ name, profileId });
      const id = spaces.size + 1;
      const space = {
        id,
        name,
        taskId: name,
        lifecycle: "active",
        ownership: "agent",
        profileId: profileId === "Temporary" ? "temporary" : "default",
        profileMode: profileId === "Temporary" ? "temporary" : "persistent",
        sessionScopeId: profileId === "Temporary" ? "scope-1" : undefined,
        activeTabId: `page-${id}`,
        tabs: [
          {
            targetId: `page-${id}`,
            title: "New Tab",
            url: "https://www.google.com/",
          },
        ],
      };
      spaces.set(id, space);
      return structuredClone(space);
    },
    getSpaceOrThrow: (id: number) => {
      const space = spaces.get(id);
      if (!space) throw new Error("task space not found");
      return space;
    },
    closeSpace: async (id: number) => {
      spaces.delete(id);
      return true;
    },
    createAgentTab: async (id: number, url: string) => {
      const space = spaces.get(id);
      space.tabs[0].url = url;
      return { targetId: space.activeTabId, url };
    },
    setAgentConnectionActive: () => undefined,
  };
  const broker = {
    registerConnection: () => undefined,
    removeConnection: () => undefined,
    releaseConnectionSpace: () => undefined,
  };
  const snapshot = {
    snapshot: async () => ({ content: "ok", refs: [] }),
    resolveHistoricalRef: async () => undefined,
  };
  const server = new AgentServer(
    socketPath,
    manager as any,
    new SpaceLeaseRegistry(),
    snapshot as any,
    broker as any,
  );
  let socket: Socket | undefined;
  try {
    await server.listen();
    socket = await connectSocket(socketPath);

    const profiles = await rpc(socket, 1, "listProfiles", []);
    assert.deepEqual(profiles.result.profiles[0], {
      id: "Temporary",
      isDefault: false,
      name: "临时 Profile",
    });

    const temporary = await rpc(socket, 2, "bootstrapTaskSpace", [{
      name: "isolated Agent Space",
      profileId: "Temporary",
      url: "https://example.com/",
    }]);
    assert.equal(temporary.result.profileMode, "temporary");
    assert.equal(temporary.result.profileId, "temporary");
    assert.equal(temporary.result.verified, true);
    assert.equal(temporary.result.url, "https://example.com/");
    assert.deepEqual(creations, [
      { name: "isolated Agent Space", profileId: "Temporary" },
    ]);

    const invalid = await rpc(socket, 3, "bootstrapTaskSpace", [{ name: "bad", profileId: {} }]);
    assert.equal(invalid.type, "rpc-error");
    assert.match(invalid.error, /profileId must be a non-empty string/);
  } finally {
    socket?.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CDP sends stay multiplexed while an earlier command is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "x-browser-agent-cdp-"));
  const socketPath = join(root, "agent.sock");
  const space: any = {
    id: 9,
    name: "cdp",
    taskId: "cdp",
    lifecycle: "active",
    ownership: "agent",
    activeTabId: "page-1",
    tabs: [{ targetId: "page-1", title: "Page", url: "https://example.com" }],
  };
  let sender: ((payload: string) => void) | undefined;
  let releaseSlow!: () => void;
  let markSlowStarted!: () => void;
  const slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));
  const slowStarted = new Promise<void>((resolve) => (markSlowStarted = resolve));
  const manager = {
    getSpaceOrThrow: (id: number) => {
      if (id !== space.id) throw new Error("task space not found");
      return space;
    },
    setAgentConnectionActive: () => undefined,
  };
  const broker = {
    registerConnection: (_id: string, next: (payload: string) => void) => {
      sender = next;
    },
    removeConnection: () => undefined,
    releaseConnectionSpace: () => undefined,
    send: async (
      _connectionId: string,
      _spaceId: number,
      _generation: number,
      payload: string,
    ) => {
      const message = JSON.parse(payload);
      if (message.method === "Runtime.evaluate") {
        markSlowStarted();
        await slowGate;
      }
      sender?.(
        JSON.stringify({
          id: message.id,
          result: { method: message.method },
        }),
      );
    },
  };
  const server = new AgentServer(
    socketPath,
    manager as any,
    new SpaceLeaseRegistry(),
    { snapshot: async () => ({ content: "", refs: [] }) } as any,
    broker as any,
  );
  let socket: Socket | undefined;
  try {
    await server.listen();
    socket = await connectSocket(socketPath);
    await rpc(socket, 1, "useTaskSpace", [space.id]);

    const slowResult = cdpMessage(socket, 101);
    socket.write(
      `${JSON.stringify({
        type: "cdp-send",
        payload: JSON.stringify({ id: 101, method: "Runtime.evaluate" }),
      })}\n`,
    );
    await slowStarted;

    const fastResult = cdpMessage(socket, 102);
    socket.write(
      `${JSON.stringify({
        type: "cdp-send",
        payload: JSON.stringify({ id: 102, method: "Fetch.fulfillRequest" }),
      })}\n`,
    );
    assert.deepEqual(await withTimeout(fastResult, 250), {
      id: 102,
      result: { method: "Fetch.fulfillRequest" },
    });
    releaseSlow();
    assert.deepEqual(await slowResult, {
      id: 101,
      result: { method: "Runtime.evaluate" },
    });
  } finally {
    releaseSlow();
    socket?.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("AgentServer exposes cursor-based Space events and one-way action trace", async () => {
  const root = await mkdtemp(join(tmpdir(), "x-browser-agent-events-"));
  const socketPath = join(root, "agent.sock");
  const space: any = {
    id: 12,
    name: "events",
    taskId: "events",
    lifecycle: "active",
    ownership: "agent",
    activeTabId: "page-12",
    tabs: [{ targetId: "page-12", title: "Page", url: "https://example.com" }],
  };
  const manager = {
    getSpace: (id: number) => (id === space.id ? space : undefined),
    getSpaceOrThrow: (id: number) => {
      if (id !== space.id) throw new Error("task space not found");
      return space;
    },
    setAgentConnectionActive: () => undefined,
  };
  const broker = {
    registerConnection: () => undefined,
    removeConnection: () => undefined,
    releaseConnectionSpace: () => undefined,
  };
  const journal = new SpaceEventJournal();
  await journal.initialize();
  const trace = new AgentTraceService(journal, manager as any);
  const server = new AgentServer(
    socketPath,
    manager as any,
    new SpaceLeaseRegistry(),
    { snapshot: async () => ({ content: "", refs: [] }) } as any,
    broker as any,
    "0.1.11",
    journal,
    trace,
  );
  let socket: Socket | undefined;
  try {
    await server.listen();
    socket = await connectSocket(socketPath);
    await rpc(socket, 1, "useTaskSpace", [space.id]);
    socket.write(
      `${JSON.stringify({
        type: "trace-event",
        payload: {
          phase: "started",
          stepId: "click-1",
          action: "click",
          target: "@21",
        },
      })}\n`,
    );
    socket.write(
      `${JSON.stringify({
        type: "trace-event",
        payload: {
          phase: "finished",
          stepId: "click-1",
          action: "click",
          status: "success",
          durationMs: 12,
        },
      })}\n`,
    );
    const result = await rpc(socket, 2, "listAgentTrace", [space.id, { limit: 20 }]);
    assert.equal(result.type, "rpc-result");
    assert.deepEqual(
      result.result.events.map((event: any) => event.type),
      ["action.started", "action.finished"],
    );
    assert.equal(result.result.events[1].data.durationMs, 12);

    const successful = await rpc(socket, 3, "listAgentTrace", [
      space.id,
      { status: "success", limit: 20 },
    ]);
    assert.equal(successful.type, "rpc-result");
    assert.deepEqual(
      successful.result.events.map((event: any) => event.data.status),
      ["success"],
    );
    const invalidStatus = await rpc(socket, 4, "listAgentTrace", [
      space.id,
      { status: "broken" },
    ]);
    assert.equal(invalidStatus.type, "rpc-error");
    assert.match(invalidStatus.error, /status/i);

    const wrongSpace = await rpc(socket, 5, "listSpaceEvents", [99, {}]);
    assert.equal(wrongSpace.type, "rpc-error");
    assert.equal(wrongSpace.error_code, "EGO_TASK_SPACE_UNAVAILABLE");
  } finally {
    socket?.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

function connectSocket(path: string) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function rpc(socket: Socket, id: number, method: string, args: unknown[]) {
  return new Promise<any>((resolve, reject) => {
    let buffer = "";
    const onError = (error: Error) => reject(error);
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id !== id) continue;
        socket.off("data", onData);
        socket.off("error", onError);
        resolve(message);
        return;
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.write(`${JSON.stringify({ type: "rpc", id, method, args })}\n`);
  });
}

function cdpMessage(socket: Socket, id: number) {
  return new Promise<any>((resolve, reject) => {
    let buffer = "";
    const onError = (error: Error) => reject(error);
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const outer = JSON.parse(line);
        if (outer.type !== "cdp-message") continue;
        const message = JSON.parse(outer.payload);
        if (message.id !== id) continue;
        socket.off("data", onData);
        socket.off("error", onError);
        resolve(message);
        return;
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}
