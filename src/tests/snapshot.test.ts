import test from "node:test";
import assert from "node:assert/strict";
import {
  collisionSafeFrameRef,
  diffSnapshotContent,
  formatAxTree,
  SNAPSHOT_HISTORY_LIMIT,
  SnapshotService,
} from "../main/snapshot.js";

test("snapshot keeps backend DOM node ids as agent refs", () => {
  const refs: any[] = [];
  const content = formatAxTree(
    [
      { nodeId: "1", role: { value: "root" }, childIds: ["2"] },
      {
        nodeId: "2",
        backendDOMNodeId: 42,
        role: { value: "button" },
        name: { value: "Save" },
      },
    ],
    refs,
  );
  assert.match(content, /button "Save" \[ref=42/);
  assert.equal(refs[0].backendNodeId, 42);
});

test("snapshot refs retain iframe routing and collision-safe public ids", () => {
  const refs: any[] = [];
  const used = new Set([24]);
  const content = formatAxTree(
    [
      {
        nodeId: "1",
        backendDOMNodeId: 24,
        role: { value: "checkbox" },
        name: { value: "Verify you are human" },
      },
    ],
    refs,
    {
      frameId: "oopif-frame",
      refIdForBackendNodeId: (backendNodeId) =>
        used.has(backendNodeId) ? 1_000_000_000 : backendNodeId,
    },
  );
  assert.match(content, /checkbox "Verify you are human" \[ref=1000000000/);
  assert.equal(refs[0].backendNodeId, 24);
  assert.equal(refs[0].refId, 1_000_000_000);
  assert.equal(refs[0].frameId, "oopif-frame");
});

test("snapshot omits non-executable stable locator placeholders", () => {
  const refs: any[] = [];
  const content = formatAxTree(
    [
      {
        nodeId: "1",
        backendDOMNodeId: 42,
        role: { value: "button" },
        name: { value: "" },
      },
    ],
    refs,
  );
  assert.equal(content, "button [ref=42]");
  assert.equal(refs[0].loc, undefined);
});

test("snapshot emits locators only when they are unique and root-executable", () => {
  const refs: any[] = [];
  const content = formatAxTree(
    [
      { nodeId: "1", role: { value: "root" }, childIds: ["2", "3", "4"] },
      {
        nodeId: "2",
        backendDOMNodeId: 42,
        role: { value: "button" },
        name: { value: "Save" },
      },
      {
        nodeId: "3",
        backendDOMNodeId: 43,
        role: { value: "button" },
        name: { value: "Save" },
      },
      {
        nodeId: "4",
        backendDOMNodeId: 44,
        role: { value: "iframe" },
        name: { value: "Embedded" },
        childIds: ["5"],
      },
      {
        nodeId: "5",
        backendDOMNodeId: 45,
        role: { value: "button" },
        name: { value: "Inside frame" },
      },
    ],
    refs,
  );
  assert.match(content, /button "Save" \[ref=42, loc=ambiguous, hint=use nth\(0\) of 2\]/);
  assert.match(content, /button "Save" \[ref=43, loc=ambiguous, hint=use nth\(1\) of 2\]/);
  assert.match(content, /iframe "Embedded" \[ref=44, loc=role:iframe/);
  assert.doesNotMatch(content, /Inside frame.*loc=/);
});

test("snapshot exposes structural role locators without assuming HTML tags", () => {
  const refs: any[] = [];
  const content = formatAxTree(
    [
      { nodeId: "1", role: { value: "dialog" }, name: { value: "OTP" }, childIds: ["2"] },
      { nodeId: "2", backendDOMNodeId: 52, role: { value: "textbox" }, name: { value: "PIN" } },
    ],
    refs,
  );
  assert.match(content, /dialog "OTP" \[loc=role:dialog\[name="OTP"\]\]/);
  assert.match(content, /textbox "PIN" \[ref=52, loc=role:textbox\[name="PIN"\]\]/);
});

test("Snapshot V2 filtering preserves backend refs across full and interactive views", () => {
  const nodes: any[] = [
    { nodeId: "1", role: { value: "rootWebArea" }, childIds: ["2", "3"] },
    { nodeId: "2", role: { value: "staticText" }, name: { value: "Long introduction" } },
    { nodeId: "3", backendDOMNodeId: 77, role: { value: "button" }, name: { value: "Continue" } },
  ];
  const fullRefs: any[] = [];
  const interactiveRefs: any[] = [];
  const full = formatAxTree(nodes, fullRefs);
  const interactive = formatAxTree(nodes, interactiveRefs, { interactive: true });
  assert.match(full, /Long introduction/);
  assert.doesNotMatch(interactive, /Long introduction/);
  assert.match(interactive, /button "Continue" \[ref=77/);
  assert.equal(fullRefs[0].refId, interactiveRefs[0].refId);
});

test("Snapshot V2 viewport filtering retains visible ancestors and stable refs", () => {
  const refs: any[] = [];
  const content = formatAxTree(
    [
      { nodeId: "1", role: { value: "rootWebArea" }, childIds: ["2", "3"] },
      { nodeId: "2", backendDOMNodeId: 66, role: { value: "button" }, name: { value: "Offscreen" } },
      { nodeId: "3", role: { value: "group" }, name: { value: "Visible group" }, childIds: ["4"] },
      { nodeId: "4", backendDOMNodeId: 77, role: { value: "button" }, name: { value: "Continue" } },
    ],
    refs,
    { visibleBackendNodeIds: new Set([77]) },
  );
  assert.match(content, /Visible group/);
  assert.match(content, /button "Continue" \[ref=77/);
  assert.doesNotMatch(content, /Offscreen/);
  assert.equal(refs[0].refId, 77);
});

test("Snapshot V2 supports selector roots, depth, compact text, and explicit URLs", () => {
  const refs: any[] = [];
  const content = formatAxTree(
    [
      { nodeId: "1", role: { value: "rootWebArea" }, childIds: ["2", "5"] },
      { nodeId: "2", backendDOMNodeId: 20, role: { value: "form" }, name: { value: "Register" }, childIds: ["3"] },
      { nodeId: "3", role: { value: "group" }, name: { value: "Fields" }, childIds: ["4"] },
      { nodeId: "4", backendDOMNodeId: 40, role: { value: "link" }, name: { value: "Terms" }, properties: [{ name: "url", value: { value: "https://example.com/terms" } }] },
      { nodeId: "5", backendDOMNodeId: 50, role: { value: "button" }, name: { value: "Outside" } },
    ],
    refs,
    {
      compact: true,
      depth: 1,
      urls: true,
      rootBackendNodeIds: new Set([20]),
    },
  );
  assert.match(content, /form "Register"/);
  assert.match(content, /group "Fields"/);
  assert.doesNotMatch(content, /Outside/);
  assert.doesNotMatch(content, /link "Terms"/);

  const deepRefs: any[] = [];
  const deep = formatAxTree(
    [
      { nodeId: "1", role: { value: "rootWebArea" }, childIds: ["2"] },
      { nodeId: "2", backendDOMNodeId: 20, role: { value: "form" }, name: { value: "Register" }, childIds: ["3"] },
      { nodeId: "3", backendDOMNodeId: 40, role: { value: "link" }, name: { value: "Terms" }, properties: [{ name: "url", value: { value: "https://example.com/terms" } }] },
    ],
    deepRefs,
    { urls: true, rootBackendNodeIds: new Set([20]) },
  );
  assert.match(deep, /url="https:\/\/example\.com\/terms"/);
});

test("Snapshot V2 redacts sensitive link URLs and avoids unusable href locators", () => {
  const refs: any[] = [];
  const content = formatAxTree(
    [
      {
        nodeId: "1",
        backendDOMNodeId: 40,
        role: { value: "link" },
        name: { value: "Reset account" },
        properties: [
          {
            name: "url",
            value: { value: "https://example.com/reset?token=do-not-store" },
          },
        ],
      },
    ],
    refs,
    { urls: true },
  );
  assert.doesNotMatch(content, /do-not-store/);
  assert.doesNotMatch(content, /loc=href:/);
  assert.match(content, /loc=role:link\[name="Reset account"\]/);
  assert.match(content, /redacted/i);
});

test("Snapshot V2 delta identifies stable changes and bounds large replacements", () => {
  const delta = diffSnapshotContent(
    'button "Send" [ref=1]\nstaticText "Ready"',
    'button "Sent" [ref=1]\ntextbox "OTP" [ref=2]',
    "old",
    "new",
  );
  assert.equal(delta.changed, 1);
  assert.equal(delta.added, 1);
  assert.equal(delta.removed, 1);
  assert.match(delta.content, /changed:/);
  assert.match(delta.content, /added:/);
  assert.match(delta.content, /removed:/);

  const large = diffSnapshotContent(
    Array.from({ length: 30 }, (_, index) => `staticText "old-${index}"`).join("\n"),
    Array.from({ length: 30 }, (_, index) => `staticText "new-${index}"`).join("\n"),
    "a",
    "b",
  );
  assert.equal(large.tooLarge, true);

  const sensitive = diffSnapshotContent(
    'StaticText "Ready"',
    'StaticText "password=do-not-store"',
    "a",
    "b",
  );
  assert.doesNotMatch(sensitive.content, /do-not-store/);
  assert.match(sensitive.content, /redacted/);
});

test("OOPIF collision refs are deterministic across filtered views", () => {
  const first = collisionSafeFrameRef("frame-a", 24, new Set([24]));
  const second = collisionSafeFrameRef("frame-a", 24, new Set([24]));
  assert.equal(first, second);
  assert.ok(first >= 1_000_000_000);
});

test("SnapshotService returns revision deltas and explicit full fallbacks", async () => {
  let generation = 0;
  let nodes: any[] = [
    { nodeId: "1", role: { value: "rootWebArea" }, childIds: ["2"] },
    { nodeId: "2", backendDOMNodeId: 9, role: { value: "button" }, name: { value: "Send" } },
  ];
  let attached = false;
  const debuggerApi = {
    isAttached: () => attached,
    attach: () => { attached = true; },
    sendCommand: async (method: string) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: { documentId: "document-1", generation } } };
      }
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "Target.getTargets") return { targetInfos: [] };
      throw new Error(`unexpected command ${method}`);
    },
  };
  const webContents = { debugger: debuggerApi };
  const manager = {
    getActiveTab: () => ({ targetId: "tab-1" }),
    ensureTabRuntime: async () => ({ webContents }),
  };
  const service = new SnapshotService(manager as any);
  const initial: any = await service.snapshot(1, { interactive: true });
  assert.equal(initial.kind, "full");
  assert.match(initial.revision, /^document-1:0:/);

  generation = 1;
  nodes = [
    { nodeId: "1", role: { value: "rootWebArea" }, childIds: ["2", "3"] },
    { nodeId: "2", backendDOMNodeId: 9, role: { value: "button" }, name: { value: "Sent" } },
    { nodeId: "3", backendDOMNodeId: 10, role: { value: "textbox" }, name: { value: "OTP" } },
  ];
  const changed: any = await service.snapshot(1, {
    interactive: true,
    sinceRevision: initial.revision,
  });
  assert.equal(changed.kind, "delta");
  assert.deepEqual(changed.changes, { changed: 1, added: 1, removed: 0 });
  assert.match(changed.content, /button "Sent"/);

  const fallback: any = await service.snapshot(1, {
    interactive: true,
    sinceRevision: "missing-revision",
  });
  assert.equal(fallback.kind, "full");
  assert.equal(fallback.fallbackReason, "baseline-unavailable");
});

test("SnapshotService falls back when an OOPIF cannot be captured completely", async () => {
  let generation = 0;
  let attached = false;
  const webContents = {
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      sendCommand: async (method: string) => {
        if (method === "Runtime.evaluate") {
          return { result: { value: { documentId: "document-1", generation } } };
        }
        if (method === "Accessibility.enable") return {};
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              { nodeId: "1", role: { value: "rootWebArea" }, childIds: ["2"] },
              { nodeId: "2", backendDOMNodeId: 9, role: { value: "button" }, name: { value: `Send ${generation}` } },
            ],
          };
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: { id: "root" },
              childFrames: [{ frame: { id: "child-frame" } }],
            },
          };
        }
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "Target.getTargets") {
          return {
            targetInfos: [
              { targetId: "child-frame", type: "iframe", title: "Child", url: "https://frame.test" },
            ],
          };
        }
        if (method === "Target.attachToTarget") {
          throw new Error("frame navigated during capture");
        }
        throw new Error(`unexpected command ${method}`);
      },
    },
  };
  const manager = {
    getActiveTab: () => ({ targetId: "tab-1" }),
    ensureTabRuntime: async () => ({ webContents }),
  };
  const service = new SnapshotService(manager as any);
  const initial: any = await service.snapshot(1, { interactive: true });
  generation = 1;
  const fallback: any = await service.snapshot(1, {
    interactive: true,
    sinceRevision: initial.revision,
  });
  assert.equal(fallback.kind, "full");
  assert.equal(fallback.fallbackReason, "frame-coverage-incomplete");
});

test("SnapshotService recovers a replaced DOM node through one stable locator", async () => {
  let generation = 0;
  let backendNodeId = 9;
  let attached = false;
  const webContents = {
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      sendCommand: async (method: string) => {
        if (method === "Runtime.evaluate") {
          return { result: { value: { documentId: "document-1", generation } } };
        }
        if (method === "Accessibility.enable") return {};
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              { nodeId: "1", role: { value: "rootWebArea" }, childIds: ["2"] },
              { nodeId: "2", backendDOMNodeId: backendNodeId, role: { value: "button" }, name: { value: "Send" } },
            ],
          };
        }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "Target.getTargets") return { targetInfos: [] };
        throw new Error(`unexpected command ${method}`);
      },
    },
  };
  const manager = {
    getActiveTab: () => ({ targetId: "tab-1" }),
    ensureTabRuntime: async () => ({ webContents }),
  };
  const service = new SnapshotService(manager as any);
  await service.snapshot(1);
  generation = 1;
  backendNodeId = 19;
  const recovered = await service.resolveHistoricalRef(1, 9);
  assert.equal(recovered?.refId, 9);
  assert.equal(recovered?.backendNodeId, 19);
});

test("SnapshotService evicts old revision baselines at the configured bound", async () => {
  let generation = 0;
  let attached = false;
  const webContents = {
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      sendCommand: async (method: string) => {
        if (method === "Runtime.evaluate") {
          return { result: { value: { documentId: "document-1", generation } } };
        }
        if (method === "Accessibility.enable") return {};
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              { nodeId: "1", role: { value: "rootWebArea" }, childIds: ["2"] },
              { nodeId: "2", backendDOMNodeId: 9, role: { value: "button" }, name: { value: `Send ${generation}` } },
            ],
          };
        }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "Target.getTargets") return { targetInfos: [] };
        throw new Error(`unexpected command ${method}`);
      },
    },
  };
  const manager = {
    getActiveTab: () => ({ targetId: "tab-1" }),
    ensureTabRuntime: async () => ({ webContents }),
  };
  const service = new SnapshotService(manager as any);
  const initial: any = await service.snapshot(1);
  for (generation = 1; generation <= SNAPSHOT_HISTORY_LIMIT; generation += 1) {
    await service.snapshot(1);
  }
  const expired: any = await service.snapshot(1, {
    sinceRevision: initial.revision,
  });
  assert.equal(expired.kind, "full");
  assert.equal(expired.fallbackReason, "baseline-unavailable");
});

test("SnapshotService rejects invalid V2 bounds before touching a page", async () => {
  const service = new SnapshotService({} as any);
  await assert.rejects(
    () => service.snapshot(1, { depth: 65 }),
    /snapshot depth/,
  );
  await assert.rejects(
    () => service.snapshot(1, { scope: "visible" as any }),
    /snapshot scope/,
  );
  await assert.rejects(
    () => service.snapshot(1, { maxResultLength: -1 }),
    /maxResultLength/,
  );
});
