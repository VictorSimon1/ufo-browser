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
      focused: false,
      send() {},
      focus() {
        this.focused = true;
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
  options: { overviewAttached?: boolean; agentControlled?: boolean } = {},
) {
  const overview = fakeView("overview");
  const browser = fakeView("browser");
  const chat = fakeView("chat");
  const page = fakeView("page");
  const overlay = fakeView("overlay");
  const events: string[] = [];
  let minimumChildren = Number.POSITIVE_INFINITY;
  const children: FakeView[] = options.overviewAttached === false ? [] : [overview];
  const contentView = {
    children,
    addChildView(view: FakeView) {
      if (!children.includes(view)) children.push(view);
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
    on() {},
    getContentSize: () => [1200, 800] as [number, number],
    isMinimized: () => false,
    isVisible: () => true,
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
      ownership: options.agentControlled ? "agent" : "user",
      lifecycle: "active",
      tabs: [{ targetId: "target-1" }],
      activeTabId: "target-1",
    }),
    listSpaces: () => [
      { id: 1, tabs: [{ targetId: "target-1" }] },
    ],
    getView: (targetId: string) => targetId === "target-1" ? page : undefined,
  };
  const coordinator = new PresentationCoordinator(
    window as any,
    { chat, overview, browser, overlay } as any,
    manager as any,
  );
  return {
    coordinator,
    views: { chat, overview, browser, page, overlay },
    children,
    events,
    minimumChildren: () => minimumChildren,
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
    y: 82,
    width: 1200,
    height: 718,
  });
  assert.equal(state.views.overlay.webContents.focused, true);

  await state.coordinator.showOverview();
  assert.deepEqual(state.children.map((view) => view.name), ["overview"]);
  assert.equal(state.views.overlay.visible, false);
});
