import test from "node:test";
import assert from "node:assert/strict";
import {
  createEgoCompatibilityContext,
  EGO_GLOBAL_HELPER_NAMES,
} from "../agent/compat.js";
import * as runtime from "../agent/runtime/helpers.js";

test("the bundled UFO-Browser runtime owns the complete flat helper surface", () => {
  const context = createEgoCompatibilityContext(
    runtime.helperContext(),
    runtime,
    () => undefined,
  );
  assert.deepEqual(
    EGO_GLOBAL_HELPER_NAMES.filter((name) => typeof context[name] !== "function"),
    [],
  );
  assert.equal(typeof context.page.locator, "function");
  assert.equal(typeof context.browser.openOrReuseTab, "function");
  assert.equal(typeof context.taskSpaces.bootstrap, "function");
  assert.equal(typeof context.taskSpaces.use, "function");
  assert.equal(typeof context.fetch.server, "function");
});

test("completing an already removed task space is idempotent", async () => {
  const previousEgo = (globalThis as any).ego;
  (globalThis as any).ego = {
    listTaskSpaces: async () => ({ taskSpaces: [] }),
  };
  try {
    assert.deepEqual(
      await runtime.completeTaskSpace(36, { keep: false }),
      { done: false, skipped: "not-found" },
    );
  } finally {
    (globalThis as any).ego = previousEgo;
  }
});

test("strict task-space helpers bootstrap and resume by numeric ID", async () => {
  const previousEgo = (globalThis as any).ego;
  const calls: unknown[][] = [];
  const created = {
    id: 8,
    taskId: "isolated signup",
    name: "isolated signup",
    createdBy: "agent",
    ownership: "agent",
    profileId: "temporary",
    profileMode: "temporary",
    sessionScopeId: "scope-1",
    url: "https://example.com/",
    verified: true,
  };
  (globalThis as any).ego = {
    bootstrapTaskSpace: async (...args: unknown[]) => {
      calls.push(args);
      return created;
    },
    useTaskSpace: async (id: number) => ({ ...created, id }),
  };
  try {
    assert.deepEqual(
      await runtime.bootstrapTaskSpace({
        name: "isolated signup",
        profileId: "Temporary",
        url: "https://example.com/",
      }),
      created,
    );
    assert.deepEqual(calls, [[{
      name: "isolated signup",
      profileId: "Temporary",
      url: "https://example.com/",
    }]]);

    calls.length = 0;
    assert.deepEqual(await runtime.useTaskSpace(8), created);
    await assert.rejects(() => runtime.useTaskSpace("8" as any), /numeric Space ID/);
    assert.deepEqual(calls, []);
  } finally {
    (globalThis as any).ego = previousEgo;
  }
});

test("useTaskSpace never creates or resolves by name", async () => {
  const previousEgo = (globalThis as any).ego;
  (globalThis as any).ego = {
    useTaskSpace: async (id: number) => ({ id, name: "existing", taskId: "existing", ownership: "agent" }),
  };
  try {
    const selected = await runtime.useTaskSpace(9);
    assert.equal(selected.id, 9);
    await assert.rejects(() => runtime.useTaskSpace("existing" as any), /numeric Space ID/);
  } finally {
    (globalThis as any).ego = previousEgo;
  }
});
