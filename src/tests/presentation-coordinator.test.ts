import test from "node:test";
import assert from "node:assert/strict";
import { PresentationCoordinator } from "../main/presentation-coordinator.js";

type FakeView = ReturnType<typeof fakeView>;

function fakeView(name: string) {
  return {
    name,
    visible: false,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    webContents: {
      destroyed: false,
      focused: false,
      send() {},
      focus() {
        this.focused = true;
      },
      isDestroyed() {
        return this.destroyed;
      },
      isFocused() {
        return this.focused;
      },
    },
    setVisible(value: boolean) {
      this.visible = value;
    },
    setBounds(value: { x: number; y: number; width: number; height: number }) {
      this.bounds = value;
    },
  };
}

function harness(
  options: {
    overviewAttached?: boolean;
    agentControlled?: boolean;
    windowFocused?: boolean;
    nativeTransition?: any;
    nativeChrome?: any;
  } = {},
) {
  const overview = fakeView("overview");
  const browser = fakeView("browser");
  const chat = fakeView("chat");
  const page = fakeView("page");
  const overlay = fakeView("overlay");
  const events: string[] = [];
  const windowEvents = new Map<string, Array<() => void>>();
  let agentControlled = options.agentControlled ?? false;
  let windowFocused = options.windowFocused ?? true;
  let minimumChildren = Number.POSITIVE_INFINITY;
  const children: FakeView[] = options.overviewAttached === false ? [] : [overview];
  const contentView = {
    children,
    addChildView(view: FakeView, index?: number) {
      if (!children.includes(view)) {
        if (index === undefined) children.push(view);
        else children.splice(Math.max(0, Math.min(index, children.length)), 0, view);
      }
      minimumChildren = Math.min(minimumChildren, children.length);
      events.push(`add:${view.name}`);
    },
    removeChildView(view: FakeView) {
      const index = children.indexOf(view);
      if (index >= 0) children.splice(index, 1);
      minimumChildren = Math.min(minimumChildren, children.length);
      events.push(`remove:${view.name}`);
    },
  };
  const window = {
    contentView,
    on(event: string, listener: () => void) {
      const listeners = windowEvents.get(event) ?? [];
      listeners.push(listener);
      windowEvents.set(event, listeners);
    },
    getContentSize: () => [1200, 800] as [number, number],
    isMinimized: () => false,
    isVisible: () => true,
    isFocused: () => windowFocused,
  };
  const manager = {
    getActiveTab: () => ({ targetId: "target-1" }),
    activeViewForPresentation: async () => page,
    prepareForPresentation: async () => undefined,
    cancelPresentationPreparation() {},
    parkAfterPresentation: async () => undefined,
    setPresentedTarget() {},
    setOverviewPreviewActive() {},
    setPageViewport() {},
    getSpace: () => ({
      id: 1,
      name: "Space 1",
      ownership: agentControlled ? "agent" : "user",
      lifecycle: "active",
      tabs: [{ targetId: "target-1" }],
      activeTabId: "target-1",
    }),
    listSpaces: () => [
      { id: 1, tabs: [{ targetId: "target-1" }] },
    ],
    getView: (targetId: string) => targetId === "target-1" ? page : undefined,
    navigationState: () => ({ loading: false }),
  };
  const coordinator = new PresentationCoordinator(
    window as any,
    { chat, overview, browser, overlay } as any,
    manager as any,
    options.nativeTransition,
    options.nativeChrome,
  );
  return {
    coordinator,
    views: { chat, overview, browser, page, overlay },
    children,
    events,
    minimumChildren: () => minimumChildren,
    setAgentControlled(value: boolean) {
      agentControlled = value;
    },
    setWindowFocused(value: boolean) {
      windowFocused = value;
    },
    emitWindow(event: string) {
      for (const listener of windowEvents.get(event) ?? []) listener();
    },
  };
}

test("Overview and Space transitions attach the destination before removing the source", async () => {
  const state = harness();

  await state.coordinator.showSpace(1);
  assert.deepEqual(state.children.map((view) => view.name), ["browser", "page"]);
  assert.ok(
    state.events.indexOf("add:browser") < state.events.indexOf("remove:overview"),
  );
  assert.ok(
    state.events.indexOf("add:page") < state.events.indexOf("remove:overview"),
  );

  const returnStart = state.events.length;
  await state.coordinator.showOverview();
  const returnEvents = state.events.slice(returnStart);
  assert.deepEqual(state.children.map((view) => view.name), ["overview"]);
  assert.ok(
    returnEvents.indexOf("add:overview") < returnEvents.indexOf("remove:page"),
  );
  assert.ok(
    returnEvents.indexOf("add:overview") < returnEvents.indexOf("remove:browser"),
  );
  assert.ok(state.minimumChildren() >= 1);
});

test("returning to Overview starts from the maintained snapshot before refreshing it", async () => {
  const calls: string[] = [];
  const nativeTransition = {
    hasSnapshot: () => true,
    beginExit: (_spaceId: number, token: string) => {
      calls.push("begin-exit");
      return { token, durationMs: 1, startedAt: performance.now() - 1 };
    },
    remainingMs: () => 0,
    capture: async () => {
      calls.push("capture");
      return true;
    },
    finish: () => {
      calls.push("finish");
      return true;
    },
    cancel: () => true,
  };
  const nativeChrome = {
    isAvailable: () => true,
    setVisible() {},
    capturePng: () => Buffer.from("chrome"),
  };
  const state = harness({ nativeTransition, nativeChrome });
  state.coordinator.setOverviewTargets([
    { id: 1, rect: { x: 40, y: 120, width: 360, height: 240 } },
  ]);

  await state.coordinator.showSpace(1);
  calls.length = 0;
  await state.coordinator.showOverview();

  assert.ok(calls.indexOf("begin-exit") >= 0);
  assert.ok(calls.indexOf("capture") > calls.indexOf("begin-exit"));
  assert.ok(calls.indexOf("finish") > calls.indexOf("capture"));
});

test("a cold Overview return becomes visible before snapshot capture completes", async () => {
  let releaseCapture!: (value: boolean) => void;
  const capturePending = new Promise<boolean>((resolve) => {
    releaseCapture = resolve;
  });
  const nativeTransition = {
    hasSnapshot: () => false,
    capture: () => capturePending,
    finish: () => true,
    cancel: () => true,
  };
  const nativeChrome = {
    isAvailable: () => true,
    setVisible() {},
    capturePng: () => Buffer.from("chrome"),
  };
  const state = harness({ nativeTransition, nativeChrome });
  state.coordinator.setOverviewTargets([
    { id: 1, rect: { x: 40, y: 120, width: 360, height: 240 } },
  ]);

  await state.coordinator.showSpace(1);
  const closing = state.coordinator.showOverview();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.views.overview.visible, true);
  assert.deepEqual(state.coordinator.current(), { kind: "overview" });
  releaseCapture(true);
  await closing;
});

test("native snapshot handoff keeps Overview above the prepared destination", async () => {
  let finishCalls = 0;
  const nativeTransition = {
    hasSnapshot: () => true,
    begin: (_spaceId: number, token: string) => ({
      token,
      durationMs: 40,
      startedAt: performance.now(),
    }),
    remainingMs: () => 40,
    finish: () => {
      finishCalls += 1;
      return true;
    },
    cancel: () => true,
  };
  const state = harness({ nativeTransition });
  const token = "space-1-transition";
  const opening = state.coordinator.showSpace(1, {
    source: { x: 40, y: 120, width: 360, height: 240 },
    token,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.children.map((view) => view.name), [
    "browser",
    "page",
    "overview",
  ]);
  assert.equal(state.coordinator.current().kind, "overview");

  await opening;
  assert.deepEqual(state.children.map((view) => view.name), ["browser", "page"]);
  assert.deepEqual(state.coordinator.current(), { kind: "space", spaceId: 1 });
  assert.equal(finishCalls, 1);
});

test("a transition request commits directly when no native snapshot is available", async () => {
  const state = harness();
  await state.coordinator.showSpace(1, {
    source: { x: 40, y: 120, width: 360, height: 240 },
    token: "space-1-no-native-transition",
  });
  assert.deepEqual(state.children.map((view) => view.name), ["browser", "page"]);
  assert.deepEqual(state.coordinator.current(), { kind: "space", spaceId: 1 });
});

test("re-publishing Overview does not detach its native view", async () => {
  const state = harness();
  await state.coordinator.showOverview();
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.children.map((view) => view.name), ["overview"]);
});

test("the first cold-start Overview presentation attaches its native view", async () => {
  const state = harness({ overviewAttached: false });
  await state.coordinator.showOverview();
  assert.deepEqual(state.events, ["add:overview"]);
  assert.deepEqual(state.children.map((view) => view.name), ["overview"]);
  assert.equal(state.views.overview.visible, true);
});

test("an Agent-controlled Space places the App overlay above the page only while presented", async () => {
  const state = harness({ agentControlled: true });

  await state.coordinator.showSpace(1);
  assert.deepEqual(state.children.map((view) => view.name), [
    "browser",
    "page",
    "overlay",
  ]);
  assert.equal(state.views.overlay.visible, true);
  assert.deepEqual(state.views.overlay.bounds, {
    x: 0,
    y: 94,
    width: 1200,
    height: 706,
  });
  assert.equal(state.views.overlay.webContents.focused, true);

  await state.coordinator.showOverview();
  assert.deepEqual(state.children.map((view) => view.name), ["overview"]);
  assert.equal(state.views.overlay.visible, false);
});

test("background Agent overlay updates never focus UFO-Browser", async () => {
  const state = harness({ agentControlled: true, windowFocused: false });

  await state.coordinator.showSpace(1);
  assert.equal(state.views.overlay.visible, true);
  assert.equal(state.views.overlay.webContents.focused, false);

  state.setWindowFocused(true);
  state.emitWindow("focus");
  assert.equal(state.views.overlay.webContents.focused, true);
});

test("removing the overlay restores page focus only in the foreground", async () => {
  const state = harness({ agentControlled: true });
  await state.coordinator.showSpace(1);
  assert.equal(state.views.overlay.webContents.focused, true);

  state.views.page.webContents.focused = false;
  state.setWindowFocused(false);
  state.setAgentControlled(false);
  state.coordinator.refreshControlOverlay();
  assert.equal(state.views.page.webContents.focused, false);
});

test("overlay removal skips focus after the presented page is destroyed", async () => {
  const state = harness({ agentControlled: true });
  await state.coordinator.showSpace(1);

  state.views.page.webContents.destroyed = true;
  state.views.page.webContents.focused = false;
  state.setAgentControlled(false);

  assert.doesNotThrow(() => state.coordinator.refreshControlOverlay());
  assert.equal(state.views.page.webContents.focused, false);
});
