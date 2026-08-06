import { inspect } from "node:util";

type AsyncHelper = (...args: any[]) => any;
type HelperContext = Record<string, any>;
// The imported ego harness installs its own facade on globalThis. Capture
// Node's callable fetch while this compatibility module is initialized first.
const nodeFetch =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : undefined;

// Keep this list in lockstep with ego-browser/src/index.ts
// LEGACY_GLOBAL_HELPERS. The installed Ego Skill is allowed to use either its
// documented convenience names or this lower-level global surface, so an
// UFO-Browser scripts should not need source edits when moved between runtimes.
export const EGO_GLOBAL_HELPER_NAMES = [
  "click",
  "dblclick",
  "hover",
  "drag",
  "wheel",
  "scrollIntoViewIfNeeded",
  "press",
  "insertText",
  "focus",
  "fill",
  "pressSequentially",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "dispatchEvent",
  "textContent",
  "innerText",
  "inputValue",
  "isChecked",
  "getAttribute",
  "count",
  "allInnerTexts",
  "allTextContents",
  "evaluateAll",
  "goto",
  "pageInfo",
  "listTabs",
  "currentTab",
  "switchTab",
  "openOrReuseTab",
  "closeTab",
  "snapshot",
  "snapshotRaw",
  "screenshot",
  "elementCenter",
  "drainEvents",
  "waitForTimeout",
  "waitForLoadState",
  "waitForSelector",
  "waitForFunction",
  "waitForURL",
  "waitForRequest",
  "waitForResponse",
  "setInputFiles",
  "evaluate",
  "serverFetch",
  "browserFetch",
  "listTaskSpaces",
  "switchTaskSpace",
  "newTaskSpace",
  "useOrCreateTaskSpace",
  "claimTaskSpace",
  "completeTaskSpace",
  "handOffTaskSpace",
  "takeOverTaskSpace",
  "waitForAgentControl",
  "siteSkills",
  "siteSkillsForUrl",
  "runSiteTool",
  "runSiteBrowserTool",
  "learnContext",
] as const;

const secondsToMilliseconds = (value: unknown, fallback?: number) => {
  if (value === undefined) return fallback;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : fallback;
};

export function createEgoCompatibilityContext(
  modern: HelperContext,
  harness: HelperContext,
  log: (...values: unknown[]) => void,
): HelperContext {
  const page = modern.page ?? {};
  const browser = modern.browser ?? {};
  const taskSpaces = modern.taskSpaces ?? {};
  const site = modern.site ?? {};
  const egoGlobals = Object.fromEntries(
    EGO_GLOBAL_HELPER_NAMES.flatMap((name) =>
      typeof harness[name] === "function" ? [[name, harness[name]]] : [],
    ),
  );
  const compatibleFetch =
    typeof nodeFetch === "function"
      ? Object.assign(
          (...args: Parameters<typeof fetch>) => nodeFetch(...args),
          modern.fetch ?? {},
        )
      : modern.fetch;
  const withSecondOptions = (
    options: Record<string, any> = {},
    keys = ["timeout"],
  ) => {
    const converted = { ...options };
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        converted[key] = secondsToMilliseconds(options[key]);
      }
    }
    return converted;
  };

  const wait = (seconds = 1) =>
    call(
      harness.waitForTimeout ?? page.waitForTimeout,
      secondsToMilliseconds(seconds, 1000),
    );

  const gotoAndWait = (url: string, options: Record<string, any> = {}) =>
    call(harness.goto ?? page.goto, url, {
      ...options,
      timeout: secondsToMilliseconds(options.timeout, 20_000),
      settle: secondsToMilliseconds(options.settle, 0),
    });

  const waitForLoad = (
    stateOrOptions: string | Record<string, any> = "load",
    maybeOptions: Record<string, any> = {},
  ) => {
    const state = typeof stateOrOptions === "string" ? stateOrOptions : "load";
    const options =
      typeof stateOrOptions === "string" ? maybeOptions : stateOrOptions;
    return call(harness.waitForLoadState ?? page.waitForLoadState, state, {
      ...options,
      timeout: secondsToMilliseconds(options.timeout, 20_000),
    });
  };

  const scrollBy = async (dy: number, dx = 0) =>
    call(harness.evaluate ?? page.evaluate, `(() => {
      window.scrollBy(${JSON.stringify(Number(dx) || 0)}, ${JSON.stringify(Number(dy) || 0)});
      return { x: window.scrollX, y: window.scrollY };
    })()`);

  const scrollToBottomUntil = async (
    predicate: () => boolean | Promise<boolean>,
    options: { step?: number; wait?: number; maxSteps?: number } = {},
  ) => {
    const step = Number(options.step ?? 900);
    const pause = Number(options.wait ?? 1);
    const maxSteps = Math.max(1, Math.floor(Number(options.maxSteps ?? 20)));
    for (let index = 0; index < maxSteps; index += 1) {
      if (await predicate()) return true;
      await scrollBy(step);
      await wait(pause);
    }
    return Boolean(await predicate());
  };

  const captureScreenshot = (options: string | Record<string, any> = {}) =>
    call(
      harness.screenshot ?? page.screenshot,
      typeof options === "string" ? { path: options } : options,
    );

  const dispatchKey = (keyOrParams: string | Record<string, any>) =>
    typeof keyOrParams === "string"
      ? call(harness.press ?? page.keyboard?.press, keyOrParams)
      : call(modern.cdp ?? harness.cdp, "Input.dispatchKeyEvent", keyOrParams);

  const help = (...names: string[]) => {
    if (names.length === 1 && LEGACY_HELP[names[0]]) {
      return LEGACY_HELP[names[0]];
    }
    return call(modern.help ?? harness.help, ...names);
  };

  return {
    // Keep the current facade API available.
    ...modern,
    // Preserve Ego's complete raw global helper contract. The documented
    // aliases below intentionally override a few names where UFO-Browser must
    // convert Skill timeout values from seconds to milliseconds.
    ...egoGlobals,
    // Installed ego leaves Node's fetch() callable. Preserve that behavior
    // while retaining UFO-Browser's fetch.server()/fetch.browser() extensions.
    fetch: compatibleFetch,

    // ego-lite Skill compatible flat task-space helpers.
    listTaskSpaces: harness.listTaskSpaces ?? taskSpaces.list,
    switchTaskSpace: harness.switchTaskSpace ?? taskSpaces.switch,
    newTaskSpace: harness.newTaskSpace ?? taskSpaces.new,
    useOrCreateTaskSpace:
      harness.useOrCreateTaskSpace ?? taskSpaces.useOrCreate,
    claimTaskSpace: harness.claimTaskSpace ?? taskSpaces.claim,
    completeTaskSpace: harness.completeTaskSpace ?? taskSpaces.complete,
    handOffTaskSpace: harness.handOffTaskSpace ?? taskSpaces.handOff,
    takeOverTaskSpace: harness.takeOverTaskSpace ?? taskSpaces.takeOver,
    waitForAgentControl: (nameOrId?: string | number, options: Record<string, any> = {}) =>
      call(
        harness.waitForAgentControl ?? taskSpaces.waitForAgentControl,
        nameOrId,
        withSecondOptions(options),
      ),

    // Navigation and observation names used by the installed ego Skill.
    listTabs: harness.listTabs ?? browser.listTabs,
    currentTab: harness.currentTab ?? browser.currentTab,
    switchTab: harness.switchTab ?? browser.switchTab,
    openOrReuseTab: (url: string, options: Record<string, any> = {}) =>
      call(
        harness.openOrReuseTab ?? browser.openOrReuseTab,
        url,
        withSecondOptions(options, ["timeout", "settle"]),
      ),
    closeTab: harness.closeTab ?? browser.closeTab,
    ensureRealTab: harness.ensureRealTab ?? browser.ensureRealTab,
    pageInfo: harness.pageInfo ?? page.info,
    gotoAndWait,
    gotoUrl: (url: string) => call(modern.cdp ?? harness.cdp, "Page.navigate", { url }),
    snapshotText: harness.snapshot ?? page.snapshot,
    snapshotRaw: harness.snapshotRaw ?? page.snapshotRaw,
    elementCenter: harness.elementCenter ?? page.elementCenter,
    captureScreenshot,
    drainEvents: harness.drainEvents ?? page.drainEvents,

    // Trusted CDP input aliases.
    click: (target: any, options: Record<string, any> = {}) =>
      call(harness.click, target, withSecondOptions(options)),
    doubleClick: (target: any, options: Record<string, any> = {}) =>
      call(harness.dblclick, target, withSecondOptions(options)),
    hover: (target: any, options: Record<string, any> = {}) =>
      call(harness.hover, target, withSecondOptions(options)),
    dragMouse: (points: any[], options: Record<string, any> = {}) =>
      call(harness.drag, points, withSecondOptions(options)),
    scroll: (options: { dx?: number; dy?: number; x?: number; y?: number } | number = {}) => {
      const normalized =
        typeof options === "number" ? { dy: options } : options;
      return call(
        harness.wheel ?? page.mouse?.wheel,
        Number(normalized.dx ?? 0),
        Number(normalized.dy ?? 300),
        { x: normalized.x, y: normalized.y },
      );
    },
    scrollBy,
    scrollToBottomUntil,
    typeText: harness.pressSequentially ?? page.keyboard?.type,
    fillInput: (selector: string, value: string, options: Record<string, any> = {}) =>
      call(harness.fill, selector, value, withSecondOptions(options)),
    pressKey: harness.press ?? page.keyboard?.press,
    dispatchKey,
    uploadFile: harness.setInputFiles,

    // Wait/evaluate/network aliases. Legacy wait values are seconds.
    wait,
    waitForLoad,
    waitForElement: (
      selector: string,
      options: Record<string, any> = {},
    ) =>
      call(harness.waitForSelector ?? page.waitForSelector, selector, {
        ...options,
        timeout: secondsToMilliseconds(options.timeout, 20_000),
      }),
    waitForNetworkIdle: (options: Record<string, any> = {}) =>
      call(harness.waitForLoadState ?? page.waitForLoadState, "networkidle", {
        ...options,
        timeout: secondsToMilliseconds(options.timeout, 20_000),
      }),
    js: harness.evaluate ?? page.evaluate,
    cdp: modern.cdp ?? harness.cdp,
    serverFetch: harness.serverFetch ?? modern.fetch?.server,
    browserFetch: harness.browserFetch ?? modern.fetch?.browser,
    siteSkills: harness.siteSkills ?? site.skills,
    siteSkillsForUrl: harness.siteSkillsForUrl ?? site.skillsForUrl,
    runSiteTool: harness.runSiteTool ?? site.runTool,
    runSiteBrowserTool: harness.runSiteBrowserTool ?? site.runBrowserTool,
    learnContext: harness.learnContext ?? site.learnContext,
    cliLog: (...values: unknown[]) => log(...values.map(formatCliLogValue)),
    help,
  };
}

const LEGACY_HELP: Record<string, string> = {
  useOrCreateTaskSpace:
    "useOrCreateTaskSpace(nameOrId) => Promise<TaskSpace>",
  openOrReuseTab:
    "openOrReuseTab(url, { wait?, timeout?, settle?, match? }) => Promise<Tab>; timeout and settle are seconds",
  snapshotText:
    "snapshotText(options?) => Promise<string>; returns the semantic page tree with @refs and locators",
  fillInput:
    "fillInput(selectorOrRef, value, options?) => Promise<void>",
  pressKey: "pressKey(keyCombo) => Promise<void>",
  captureScreenshot:
    "captureScreenshot(pathOrOptions?) => Promise<string>; ego-compatible path strings and { path?, fullPage?, clip? } are accepted",
  snapshotRaw:
    "snapshotRaw(options?) => Promise<{ content, refs }>; structured semantic snapshot",
  elementCenter:
    "elementCenter(selectorOrRef) => Promise<{ x, y }>",
  js: "js(expression) => Promise<any>",
  wait: "wait(seconds) => Promise<void>",
  cliLog: "cliLog(value) => void",
};

function call(fn: AsyncHelper | undefined, ...args: any[]) {
  if (typeof fn !== "function") throw new Error("X_BROWSER_HELPER_UNAVAILABLE");
  return fn(...args);
}

export function formatCliLogValue(value: unknown) {
  if (typeof value === "string") return value;
  return inspect(value, { depth: 8, colors: false, compact: false });
}
