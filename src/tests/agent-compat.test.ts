import test from "node:test";
import assert from "node:assert/strict";
import {
  createEgoCompatibilityContext,
  EGO_GLOBAL_HELPER_NAMES,
  EGO_HOST_GLOBAL_HELPER_NAMES,
  installEgoCompatibilityGlobals,
} from "../agent/compat.js";

test("the complete Ego global helper contract is exposed unchanged", () => {
  const harness: Record<string, any> = Object.fromEntries(
    EGO_GLOBAL_HELPER_NAMES.map((name) => [name, () => name]),
  );
  harness.iframeTarget = () => "iframeTarget";
  const host = Object.fromEntries(
    EGO_HOST_GLOBAL_HELPER_NAMES.filter((name) => name !== "iframeTarget").map(
      (name) => [name, () => name],
    ),
  );
  const context = createEgoCompatibilityContext(
    { page: {}, browser: {}, taskSpaces: {}, site: {} },
    harness,
    () => undefined,
    host,
  );
  const missing = [
    ...EGO_GLOBAL_HELPER_NAMES,
    ...EGO_HOST_GLOBAL_HELPER_NAMES,
  ].filter(
    (name) => typeof context[name] !== "function",
  );
  assert.deepEqual(missing, []);
  assert.equal(context.check(), "check");
  assert.equal(context.selectOption(), "selectOption");
  assert.equal(context.textContent(), "textContent");
  assert.equal(context.waitForURL(), "waitForURL");
  assert.equal(context.waitForResponse(), "waitForResponse");
  assert.equal(context.createTab("https://example.com"), "createTab");
  assert.equal(context.getBrowserVersion(), "getBrowserVersion");
  assert.equal(context.iframeTarget(), "iframeTarget");
  assert.throws(
    () => context.createTab(),
    /ego\.createTab\(url\) expects a string URL/,
  );
});

test("Ego-compatible helpers are non-enumerable globals except fetch", () => {
  const target = {
    fetch: () => "native fetch",
  } as Record<string, any>;
  installEgoCompatibilityGlobals(target, {
    openOrReuseTab: () => undefined,
    createTab: () => undefined,
    fetch: () => "compatible fetch",
  });

  assert.equal(
    Object.getOwnPropertyDescriptor(target, "openOrReuseTab")?.enumerable,
    false,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(target, "createTab")?.enumerable,
    false,
  );
  assert.equal(Object.getOwnPropertyDescriptor(target, "fetch")?.enumerable, true);
  assert.deepEqual(Object.keys(target), ["fetch"]);
});

test("legacy ego Skill helper names map to the facade harness", async () => {
  const calls: any[] = [];
  const fn = (name: string) => (...args: any[]) => {
    calls.push([name, ...args]);
    return name;
  };
  const modern = {
    page: {
      snapshot: fn("snapshot"),
      snapshotRaw: fn("snapshotRaw"),
      elementCenter: fn("elementCenter"),
      screenshot: fn("screenshot"),
      evaluate: fn("evaluate"),
      waitForTimeout: fn("waitForTimeout"),
      waitForLoadState: fn("waitForLoadState"),
      waitForSelector: fn("waitForSelector"),
      goto: fn("goto"),
      keyboard: { type: fn("type") },
    },
    browser: { openOrReuseTab: fn("openOrReuseTab") },
    taskSpaces: { useOrCreate: fn("useOrCreate") },
    fetch: { server: fn("serverFetch"), browser: fn("browserFetch") },
    site: {
      skills: fn("siteSkills"),
      skillsForUrl: fn("siteSkillsForUrl"),
      runTool: fn("runSiteTool"),
      runBrowserTool: fn("runSiteBrowserTool"),
      learnContext: fn("learnContext"),
    },
    cdp: fn("cdp"),
  };
  const harness = {
    fill: fn("fill"),
    press: fn("press"),
    click: fn("click"),
    dblclick: fn("dblclick"),
  };
  const output: unknown[][] = [];
  const context = createEgoCompatibilityContext(
    modern,
    harness,
    (...values) => output.push(values),
  );

  assert.equal(await context.useOrCreateTaskSpace("task"), "useOrCreate");
  assert.equal(await context.snapshotText(), "snapshot");
  assert.equal(await context.snapshotRaw(), "snapshotRaw");
  assert.equal(await context.elementCenter("@12"), "elementCenter");
  assert.equal(await context.fillInput("#email", "a@b.test"), "fill");
  assert.equal(await context.pressKey("Enter"), "press");
  assert.equal(await context.doubleClick([10, 20]), "dblclick");
  assert.equal(await context.siteSkills("https://example.com"), "siteSkills");
  assert.equal(
    await context.siteSkillsForUrl("https://example.com"),
    "siteSkillsForUrl",
  );
  assert.equal(await context.runSiteTool("site", "tool", {}), "runSiteTool");
  assert.equal(
    await context.runSiteBrowserTool("site", "tool", {}),
    "runSiteBrowserTool",
  );
  assert.equal(await context.learnContext("https://example.com"), "learnContext");
  assert.equal(typeof context.fetch, "function");
  assert.equal(await context.fetch.server("https://example.com"), "serverFetch");
  assert.equal(await context.fetch.browser("https://example.com"), "browserFetch");
  assert.equal(await context.wait(1.5), "waitForTimeout");
  assert.equal(
    await context.openOrReuseTab("https://example.com", {
      timeout: 20,
      settle: 0.25,
    }),
    "openOrReuseTab",
  );
  assert.equal(await context.gotoAndWait("https://example.com", { timeout: 3 }), "goto");
  context.cliLog({ ok: true });

  assert.deepEqual(calls.find((call) => call[0] === "waitForTimeout"), [
    "waitForTimeout",
    1500,
  ]);
  assert.deepEqual(calls.find((call) => call[0] === "goto"), [
    "goto",
    "https://example.com",
    { timeout: 3000, settle: 0 },
  ]);
  assert.deepEqual(calls.find((call) => call[0] === "openOrReuseTab"), [
    "openOrReuseTab",
    "https://example.com",
    { timeout: 20_000, settle: 250 },
  ]);
  assert.match(context.help("snapshotText"), /semantic page tree/);
  assert.match(context.help("snapshotRaw"), /structured semantic snapshot/);
  assert.match(String(output[0][0]), /ok: true/);
});

test("legacy navigation timeout values are converted from seconds", async () => {
  let received: any;
  const context = createEgoCompatibilityContext(
    { page: {}, browser: {}, taskSpaces: {} },
    {
      goto: (_url: string, options: any) => {
        received = options;
      },
    },
    () => undefined,
  );
  await context.gotoAndWait("https://example.com", { timeout: 12, settle: 0.5 });
  assert.equal(received.timeout, 12_000);
  assert.equal(received.settle, 500);
});
