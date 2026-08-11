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
  assert.equal(typeof context.taskSpaces.useOrCreate, "function");
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

test("Agent task-space helpers forward an explicit temporary Profile", async () => {
  const previousEgo = (globalThis as any).ego;
  const calls: unknown[][] = [];
  const created = {
    id: 8,
    taskId: "isolated signup",
    name: "isolated signup",
    createdBy: "agent",
    ownership: "agent",
  };
  (globalThis as any).ego = {
    listTaskSpaces: async () => ({ taskSpaces: [] }),
    createTaskSpace: async (...args: unknown[]) => {
      calls.push(args);
      return created;
    },
    useTaskSpace: async () => 8,
  };
  try {
    assert.deepEqual(
      await runtime.newTaskSpace("isolated signup", {
        profileId: "Temporary",
      }),
      created,
    );
    assert.deepEqual(calls, [["isolated signup", "Temporary"]]);

    calls.length = 0;
    await runtime.useOrCreateTaskSpace("another isolated task", "Temporary");
    assert.deepEqual(calls, [["another isolated task", "Temporary"]]);
  } finally {
    (globalThis as any).ego = previousEgo;
  }
});

test("Profile options do not replace an existing task Space", async () => {
  const previousEgo = (globalThis as any).ego;
  let creations = 0;
  (globalThis as any).ego = {
    listTaskSpaces: async () => ({
      taskSpaces: [
        {
          id: 9,
          taskId: "existing",
          name: "existing",
          ownership: "agent",
        },
      ],
    }),
    createTaskSpace: async () => {
      creations += 1;
      throw new Error("must not create");
    },
    useTaskSpace: async () => 9,
  };
  try {
    const selected = await runtime.useOrCreateTaskSpace("existing", {
      profileId: "Temporary",
    });
    assert.equal(selected.id, 9);
    assert.equal(creations, 0);
  } finally {
    (globalThis as any).ego = previousEgo;
  }
});
