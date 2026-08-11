import test from "node:test";
import assert from "node:assert/strict";
import * as runtime from "../agent/runtime/helpers.js";
import { waitForActionableHandle } from "../agent/runtime/driver/element-ops.js";
import {
  browserRefMap,
  ensureRefMapForRef,
} from "../agent/runtime/ref-state.js";
import { onPageEvent } from "../agent/runtime/driver/events.js";
import { state } from "../agent/runtime/state.js";

test("expect auto-retries delayed locator state", async () => {
  let now = 0;
  let reads = 0;
  const restore = runtime.__testing.setOverrides({
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    defaultTimeout: 500,
  });
  try {
    const locator = {
      selector: "#status",
      innerText: async () => (++reads >= 4 ? "提交成功" : "正在处理"),
    };
    await runtime.expect(locator).toHaveText("提交成功");
    assert.equal(reads, 4);
  } finally {
    restore();
  }
});

test("expect reports a named TimeoutError with the final value", async () => {
  let now = 0;
  const restore = runtime.__testing.setOverrides({
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    defaultTimeout: 100,
  });
  try {
    const locator = {
      selector: "#status",
      innerText: async () => "仍在处理",
    };
    await assert.rejects(
      runtime.expect(locator).toHaveText("提交成功"),
      (error: any) => {
        assert.equal(error.name, "TimeoutError");
        assert.equal(error.locator, "#status");
        assert.match(error.message, /仍在处理/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("expect exposes the supported locator, page, and negated matchers", async () => {
  const locator = {
    selector: "#ready",
    innerText: async () => "Ready",
    isEnabled: async () => true,
    isVisible: async () => true,
    count: async () => 2,
    inputValue: async () => "accepted",
  };
  await runtime.expect(locator).toHaveText(/Ready/);
  await runtime.expect(locator).toBeEnabled();
  await runtime.expect(locator).toBeVisible();
  await runtime.expect(locator).toHaveCount(2);
  await runtime.expect(locator).toHaveValue("accepted");
  await runtime.expect(locator).not.toHaveText("Rejected");
  await runtime.expect({ url: async () => "https://example.test/dashboard" }).toHaveURL(
    /dashboard/,
  );
});

test("waitForSelector throws TimeoutError unless false is explicitly requested", async () => {
  let now = 0;
  const restore = runtime.__testing.setOverrides({
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    cdpOverride: async (method: string, params: any) => {
      if (method === "Runtime.evaluate" && params.expression === "location.href") {
        return { result: { value: "https://example.test/checkout" } };
      }
      return { result: {} };
    },
  });
  try {
    await assert.rejects(
      runtime.waitForSelector("#confirm-payment", { timeout: 40 }),
      (error: any) => {
        assert.equal(error.name, "TimeoutError");
        assert.equal(error.matchCount, 0);
        assert.equal(error.url, "https://example.test/checkout");
        return true;
      },
    );
    now = 0;
    assert.equal(
      await runtime.waitForSelector("#confirm-payment", {
        timeout: 40,
        returnFalseOnTimeout: true,
      }),
      false,
    );
  } finally {
    restore();
  }
});

test("actionability errors identify the intercepting element and retry count", async () => {
  let now = 0;
  const restore = runtime.__testing.setOverrides({
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    cdpOverride: async (method: string, params: any) => {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "covered-button" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: {
              ok: false,
              reason: "intercepted",
              interceptedBy: "#loading-overlay",
            },
          },
        };
      }
      return { result: {} };
    },
  });
  try {
    await assert.rejects(
      waitForActionableHandle("#submit", "click", { timeout: 40 }),
      (error: any) => {
        assert.equal(error.name, "ActionabilityError");
        assert.equal(error.reason, "intercepted");
        assert.equal(error.interceptedBy, "#loading-overlay");
        assert.ok(error.attempts >= 2);
        assert.match(error.message, /#loading-overlay/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("historical refs restore even when another ref already populated the local map", async () => {
  const previousEgo = (globalThis as any).ego;
  browserRefMap.clear();
  browserRefMap.add("1", 11, "button", "Current");
  (globalThis as any).ego = {
    resolveRef: async (refId: number) => ({
      refId,
      backendNodeId: 21,
      role: "button",
      name: "Previous",
      loc: 'role:button[name="Previous"]',
    }),
  };
  try {
    await ensureRefMapForRef("@21");
    assert.equal(browserRefMap.get("21")?.backendNodeId, 21);
    assert.equal(
      browserRefMap.get("21")?.selector,
      'role:button[name="Previous"]',
    );
  } finally {
    browserRefMap.clear();
    (globalThis as any).ego = previousEgo;
  }
});

test("network page listener retainers are idempotent", async () => {
  const calls: string[] = [];
  const restore = runtime.__testing.setOverrides({
    sessionId: "test-session",
    sessionTargetId: "test-target",
    networkDomainRetainers: 0,
    cdpOverride: async (method: string) => {
      calls.push(method);
      return { result: {} };
    },
  });
  try {
    const unsubscribe = onPageEvent("request", () => undefined);
    await Promise.resolve();
    assert.equal(state.networkDomainRetainers, 1);
    unsubscribe();
    assert.equal(state.networkDomainRetainers, 0);
    unsubscribe();
    assert.equal(state.networkDomainRetainers, 0);
    assert.ok(calls.includes("Network.enable"));
  } finally {
    restore();
  }
});
