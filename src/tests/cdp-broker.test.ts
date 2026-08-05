import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CdpBroker,
  collectFrameIds,
  collectDomFrameIds,
  filterScopedChildTargets,
} from "../main/cdp-broker.js";

test("Target.getTargets only exposes OOPIFs belonging to the selected page", () => {
  const frameIds = collectFrameIds({
    frame: { id: "root" },
    childFrames: [
      { frame: { id: "turnstile", url: "https://challenges.cloudflare.com" } },
    ],
  });
  const targets = filterScopedChildTargets(frameIds, [
    { targetId: "turnstile", type: "iframe", title: "", url: "https://challenges.cloudflare.com" },
    { targetId: "other-space", type: "iframe", title: "", url: "https://example.com" },
    { targetId: "page", type: "page", title: "page", url: "https://example.com" },
  ]);
  assert.deepEqual(targets.map((target) => target.targetId), ["turnstile"]);
});

test("OOPIF frame ids are recovered from iframe owner nodes", () => {
  const frameIds = collectDomFrameIds({
    nodeName: "HTML",
    children: [
      {
        nodeName: "BODY",
        children: [
          { nodeName: "IFRAME", frameId: "turnstile", children: [] },
        ],
      },
    ],
  });
  assert.deepEqual([...frameIds], ["turnstile"]);
});

test("Agent recording suspends and resumes the Overview frame subscription", async () => {
  const debuggerTransport = new FakeDebugger();
  const contents = new FakeContents(debuggerTransport);
  const suspended: string[] = [];
  const resumed: string[] = [];
  const space = {
    id: 1,
    activeTabId: "page-1",
    tabs: [{ targetId: "page-1", title: "Page", url: "https://example.com" }],
  };
  const manager = {
    getSpaceOrThrow: () => space,
    getActiveTab: () => space.tabs[0],
    activeView: async () => ({ webContents: contents }),
    ensureTabRuntime: async () => ({ webContents: contents }),
    ensureBackgroundSurface: async () => undefined,
    suspendOverviewScreencast: async (targetId: string) => {
      suspended.push(targetId);
    },
    resumeOverviewScreencast: (targetId: string) => {
      resumed.push(targetId);
    },
  };
  const broker = new CdpBroker(
    manager as any,
    { assert: () => undefined } as any,
  );
  const messages: any[] = [];
  broker.registerConnection("connection-1", (payload) => {
    messages.push(JSON.parse(payload));
  });

  await broker.send(
    "connection-1",
    1,
    1,
    JSON.stringify({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "page-1", flatten: true },
    }),
  );
  const sessionId = messages.find((message) => message.id === 1).result.sessionId;

  await broker.send(
    "connection-1",
    1,
    1,
    JSON.stringify({
      id: 2,
      method: "Page.startScreencast",
      params: { format: "jpeg" },
      sessionId,
    }),
  );
  assert.deepEqual(suspended, ["page-1"]);

  debuggerTransport.emit(
    "message",
    {},
    "Page.screencastFrame",
    { data: "agent", sessionId: 2 },
    "",
  );
  assert.equal(
    messages.filter((message) => message.method === "Page.screencastFrame").length,
    1,
  );

  await broker.send(
    "connection-1",
    1,
    1,
    JSON.stringify({
      id: 3,
      method: "Page.stopScreencast",
      params: {},
      sessionId,
    }),
  );
  assert.deepEqual(resumed, ["page-1"]);
});

test("Agent disconnect releases screencast priority only after the last session", async () => {
  const debuggerTransport = new FakeDebugger();
  const contents = new FakeContents(debuggerTransport);
  const suspended: string[] = [];
  const resumed: string[] = [];
  const space = {
    id: 1,
    activeTabId: "page-1",
    tabs: [{ targetId: "page-1", title: "Page", url: "https://example.com" }],
  };
  const manager = {
    getSpaceOrThrow: () => space,
    getActiveTab: () => space.tabs[0],
    ensureTabRuntime: async () => ({ webContents: contents }),
    ensureBackgroundSurface: async () => undefined,
    suspendOverviewScreencast: async (targetId: string) => suspended.push(targetId),
    resumeOverviewScreencast: (targetId: string) => resumed.push(targetId),
  };
  const broker = new CdpBroker(manager as any, { assert: () => undefined } as any);
  const messages: any[] = [];
  broker.registerConnection("connection-1", (payload) => messages.push(JSON.parse(payload)));

  for (const id of [1, 2]) {
    await broker.send(
      "connection-1",
      1,
      1,
      JSON.stringify({
        id,
        method: "Target.attachToTarget",
        params: { targetId: "page-1", flatten: true },
      }),
    );
    const sessionId = messages.find((message) => message.id === id).result.sessionId;
    await broker.send(
      "connection-1",
      1,
      1,
      JSON.stringify({
        id: id + 10,
        method: "Page.startScreencast",
        params: {},
        sessionId,
      }),
    );
  }
  assert.equal(suspended.length, 2);
  broker.removeConnection("connection-1");
  assert.deepEqual(resumed, ["page-1"]);
});

test("focus emulation is limited to the trusted Input gesture window", async () => {
  const debuggerTransport = new FakeDebugger();
  const contents = new FakeContents(debuggerTransport);
  const space = {
    id: 1,
    activeTabId: "page-1",
    tabs: [{ targetId: "page-1", title: "Page", url: "https://example.com" }],
  };
  const manager = {
    getSpaceOrThrow: () => space,
    getActiveTab: () => space.tabs[0],
    ensureTabRuntime: async () => ({ webContents: contents }),
    ensureBackgroundSurface: async () => undefined,
    suspendOverviewScreencast: async () => undefined,
    resumeOverviewScreencast: () => undefined,
  };
  const broker = new CdpBroker(manager as any, { assert: () => undefined } as any);
  const messages: any[] = [];
  broker.registerConnection("connection-1", (payload) => messages.push(JSON.parse(payload)));

  await broker.send(
    "connection-1",
    1,
    1,
    JSON.stringify({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "page-1", flatten: true },
    }),
  );
  const sessionId = messages.find((message) => message.id === 1).result.sessionId;
  assert.equal(
    debuggerTransport.commands.some(
      (command) => command.method === "Emulation.setFocusEmulationEnabled",
    ),
    false,
  );

  await broker.send(
    "connection-1",
    1,
    1,
    JSON.stringify({
      id: 2,
      method: "Runtime.evaluate",
      params: { expression: "document.hasFocus()" },
      sessionId,
    }),
  );
  assert.equal(
    debuggerTransport.commands.some(
      (command) => command.method === "Emulation.setFocusEmulationEnabled",
    ),
    false,
  );

  await broker.send(
    "connection-1",
    1,
    1,
    JSON.stringify({
      id: 3,
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 20, y: 20, button: "left" },
      sessionId,
    }),
  );
  assert.deepEqual(
    debuggerTransport.commands
      .filter((command) => command.method === "Emulation.setFocusEmulationEnabled")
      .map((command) => command.params.enabled),
    [true],
  );
  const released = await waitUntil(() =>
    debuggerTransport.commands.some(
      (command) =>
        command.method === "Emulation.setFocusEmulationEnabled" &&
        command.params.enabled === false,
    ),
  );
  assert.equal(released, true);
  assert.deepEqual(
    debuggerTransport.commands
      .filter((command) => command.method === "Emulation.setFocusEmulationEnabled")
      .map((command) => command.params.enabled),
    [true, false],
  );
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test("download behavior is handled locally and emits isolated synthetic Page events", async () => {
  const debuggerTransport = new FakeDebugger();
  const contents = new FakeContents(debuggerTransport);
  const space = {
    id: 1,
    activeTabId: "page-1",
    tabs: [{ targetId: "page-1", title: "Page", url: "https://example.com" }],
  };
  const manager = {
    getSpaceOrThrow: () => space,
    getActiveTab: () => space.tabs[0],
    ensureTabRuntime: async () => ({ webContents: contents }),
    ensureBackgroundSurface: async () => undefined,
    findSpaceByWebContentsId: (id: number) =>
      id === contents.id ? { space, tab: space.tabs[0] } : undefined,
    suspendOverviewScreencast: async () => undefined,
    resumeOverviewScreencast: () => undefined,
  };
  const broker = new CdpBroker(manager as any, { assert: () => undefined } as any);
  const messages: any[] = [];
  broker.registerConnection("connection-1", (payload) => messages.push(JSON.parse(payload)));

  await broker.send(
    "connection-1",
    1,
    1,
    JSON.stringify({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "page-1", flatten: true },
    }),
  );
  const sessionId = messages.find((message) => message.id === 1).result.sessionId;
  await broker.send(
    "connection-1",
    1,
    1,
    JSON.stringify({
      id: 2,
      method: "Browser.setDownloadBehavior",
      params: { behavior: "deny", eventsEnabled: true },
    }),
  );

  let prevented = false;
  contents.session.emit(
    "will-download",
    { preventDefault: () => (prevented = true) },
    new FakeDownloadItem(),
    contents,
  );
  assert.equal(prevented, true);
  const downloadEvents = messages.filter((message) =>
    String(message.method || "").startsWith("Page.download"),
  );
  assert.deepEqual(
    downloadEvents.map((message) => [message.method, message.params.state]),
    [
      ["Page.downloadWillBegin", undefined],
      ["Page.downloadProgress", "canceled"],
    ],
  );
  assert.ok(downloadEvents.every((message) => message.sessionId === sessionId));
});

class FakeDebugger extends EventEmitter {
  private attached = false;
  readonly commands: Array<{ method: string; params: any }> = [];

  isAttached() {
    return this.attached;
  }

  attach() {
    this.attached = true;
  }

  async sendCommand(method: string, params: any = {}) {
    this.commands.push({ method, params });
    return {};
  }
}

class FakeContents extends EventEmitter {
  readonly id = 42;
  readonly session = new EventEmitter();

  constructor(readonly debuggerTransport: FakeDebugger) {
    super();
  }

  get debugger() {
    return this.debuggerTransport;
  }

  isDestroyed() {
    return false;
  }

  send() {
    // Page-overlay IPC is not relevant to broker routing assertions.
  }

  async executeJavaScript() {
    return undefined;
  }
}

class FakeDownloadItem extends EventEmitter {
  getURL() {
    return "https://example.com/file.txt";
  }

  getFilename() {
    return "file.txt";
  }

  getTotalBytes() {
    return 10;
  }
}
