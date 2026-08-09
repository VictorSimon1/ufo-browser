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
