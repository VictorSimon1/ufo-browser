import test from "node:test";
import assert from "node:assert/strict";
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
