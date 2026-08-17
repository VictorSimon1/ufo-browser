import { inspect } from "node:util";
import {
  executeWorkflowReplay,
  secret as workflowSecret,
} from "./workflow-replay.js";

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
  "bootstrapTaskSpace",
  "useTaskSpace",
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

export const EGO_HOST_GLOBAL_HELPER_NAMES = [
  "createTab",
  "getBrowserVersion",
  "listProfiles",
  "markTaskSpaceError",
  "sendCDPMessage",
  "setAgentTaskState",
  "animationHighlightMouseToPosition",
  "iframeTarget",
] as const;

const CREATE_TAB_ARGUMENT_ERROR =
  "ego.createTab(url) expects a string URL.\n" +
  "Example: await ego.createTab('https://example.com')";

const secondsToMilliseconds = (value: unknown, fallback?: number) => {
  if (value === undefined) return fallback;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : fallback;
};

export function createEgoCompatibilityContext(
  modern: HelperContext,
  harness: HelperContext,
  log: (...values: unknown[]) => void,
  host: HelperContext = (globalThis as any).ego ?? {},
): HelperContext {
  const page = modern.page ?? {};
  const browser = modern.browser ?? {};
  const taskSpaces = modern.taskSpaces ?? {};
  const site = modern.site ?? {};
  const listSpaceEvents = (spaceId: number, options: Record<string, any> = {}) =>
    call(host.listSpaceEvents, spaceId, options);
  const listAgentTrace = (spaceId: number, options: Record<string, any> = {}) =>
    call(host.listAgentTrace, spaceId, options);
  const exportAgentTrace = (
    spaceId: number,
    options: { path: string; format?: "markdown" | "json" },
  ) => call(host.exportAgentTrace, spaceId, options);
  const workflows = {
    start: async (name: string) => {
      const recording = await call(host.startWorkflowRecording, name);
      return Object.freeze({
        ...recording,
        finish: (options: Record<string, any> = {}) =>
          call(host.finishWorkflowRecording, recording.id, options),
        cancel: () => call(host.cancelWorkflowRecording, recording.id),
      });
    },
    list: () => call(host.listWorkflows),
    get: (name: string, version?: number) =>
      call(host.getWorkflow, name, version),
    replay: async (
      name: string,
      inputs: Record<string, any>,
      options: Record<string, any> = {},
    ) => {
      const prepared = await call(host.prepareWorkflowReplay, name, {
        version: options.version,
      });
      return executeWorkflowReplay(prepared, inputs, options, {
        page: modern.page,
        site: modern.site,
        trace: (signal) => host.traceEvent?.(signal),
        listEvents: (after, eventOptions = {}) =>
          call(host.listSpaceEvents, prepared.spaceId, {
            ...eventOptions,
            after,
          }),
        report: (result) =>
          call(host.finishWorkflowReplay, prepared.runId, result),
      });
    },
  };
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
      // Agent workflows normally need the page to be interactive, not every
      // analytics stream, video and lazy resource to finish. Callers that
      // truly need the full load event can still request waitUntil: "load".
      waitUntil: options.waitUntil ?? "domcontentloaded",
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

  const createTab = (url: unknown) => {
    assertEgoCreateTabUrl(url);
    return call(host.createTab, url);
  };

  return {
    // Keep the current facade API available.
    ...modern,
    taskSpaces: {
      ...taskSpaces,
      events: { list: listSpaceEvents },
      trace: { list: listAgentTrace, export: exportAgentTrace },
    },
    workflows,
    secret: workflowSecret,
    // Preserve Ego's complete raw global helper contract. The documented
    // aliases below intentionally override a few names where UFO-Browser must
    // convert Skill timeout values from seconds to milliseconds.
    ...egoGlobals,
    // Installed ego leaves Node's fetch() callable. Preserve that behavior
    // while retaining UFO-Browser's fetch.server()/fetch.browser() extensions.
    fetch: compatibleFetch,

    // Raw host aliases installed by Ego alongside its runtime helpers.
    createTab,
    getBrowserVersion: (...args: any[]) => call(host.getBrowserVersion, ...args),
    listProfiles: (...args: any[]) => call(host.listProfiles, ...args),
    listSpaceEvents,
    listAgentTrace,
    exportAgentTrace,
    markTaskSpaceError: (...args: any[]) => call(host.markTaskSpaceError, ...args),
    sendCDPMessage: (...args: any[]) => call(host.sendCDPMessage, ...args),
    setAgentTaskState: (...args: any[]) => call(host.setAgentTaskState, ...args),
    animationHighlightMouseToPosition: (...args: any[]) =>
      call(host.animationHighlightMouseToPosition, ...args),
    iframeTarget: harness.iframeTarget ?? browser.iframeTarget,

    // UFO-Browser's strict two-entry task-space API.
    listTaskSpaces: harness.listTaskSpaces ?? taskSpaces.list,
    bootstrapTaskSpace:
      harness.bootstrapTaskSpace ?? taskSpaces.bootstrap,
    useTaskSpace: harness.useTaskSpace ?? taskSpaces.use,
    claimTaskSpace: harness.claimTaskSpace ?? taskSpaces.claim,
    completeTaskSpace: harness.completeTaskSpace ?? taskSpaces.complete,
    handOffTaskSpace: harness.handOffTaskSpace ?? taskSpaces.handOff,
    takeOverTaskSpace: harness.takeOverTaskSpace ?? taskSpaces.takeOver,
    // Unlike Playwright-style page methods, the task-space helper owns its
    // public timeout contract and already interprets interval/timeout as
    // seconds. Converting here made a requested 1 second timeout arrive as
    // 1000 seconds and effectively hung an Agent after handoff.
    waitForAgentControl: (
      nameOrId?: string | number,
      options: Record<string, any> = {},
    ) =>
      call(
        harness.waitForAgentControl ?? taskSpaces.waitForAgentControl,
        nameOrId,
        { ...options },
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
        returnFalseOnTimeout: true,
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

export function assertEgoCreateTabUrl(url: unknown): asserts url is string {
  if (typeof url !== "string") throw new TypeError(CREATE_TAB_ARGUMENT_ERROR);
}

export function installEgoCompatibilityGlobals(
  target: Record<string, any>,
  context: HelperContext,
) {
  for (const [name, value] of Object.entries(context)) {
    const existing = Object.getOwnPropertyDescriptor(target, name);
    if (existing && existing.configurable === false) {
      target[name] = value;
      continue;
    }
    Object.defineProperty(target, name, {
      value,
      enumerable: name === "fetch" ? (existing?.enumerable ?? true) : false,
      writable: true,
      configurable: true,
    });
  }
}

const LEGACY_HELP: Record<string, string> = {
  bootstrapTaskSpace:
    "bootstrapTaskSpace({ name, profileId?, url? }) => Promise<VerifiedTaskSpace>; always creates a new Space",
  useTaskSpace:
    "useTaskSpace(id) => Promise<TaskSpace>; accepts a positive numeric Space ID only",
  openOrReuseTab:
    "openOrReuseTab(url, { wait?, timeout?, settle?, match? }) => Promise<Tab>; timeout and settle are seconds",
  snapshotText:
    "snapshotText(options?) => Promise<string>; returns the semantic page tree or revision delta. Options: scope, interactive, compact, depth, selector, urls, boxes, sinceRevision, maxResultLength",
  fillInput:
    "fillInput(selectorOrRef, value, options?) => Promise<void>",
  pressKey: "pressKey(keyCombo) => Promise<void>",
  captureScreenshot:
    "captureScreenshot(pathOrOptions?) => Promise<string>; ego-compatible path strings and { path?, fullPage?, clip? } are accepted",
  snapshotRaw:
    "snapshotRaw(options?) => Promise<{ content, refs, revision, kind, baseRevision?, fallbackReason?, changes? }>; structured semantic snapshot using the Snapshot V2 result contract",
  listSpaceEvents:
    "listSpaceEvents(spaceId, { after?, limit?, categories? }) => Promise<{ events, nextSequence, cursorExpired }>",
  listAgentTrace:
    "listAgentTrace(spaceId, { after?, limit? }) => Promise<{ events, nextSequence, cursorExpired }>",
  exportAgentTrace:
    "exportAgentTrace(spaceId, { path, format? }) => Promise<{ path, format, events }>",
  workflows:
    "workflows.start(name) records successful traced actions until recording.finish({ variables?, secrets? }); workflows.replay(name, inputs, options?) deterministically replays without an LLM; workflows.list() and workflows.get(name, version?) inspect saved versions and statistics",
  secret:
    "secret(value) wraps an in-memory Workflow secret. Secret values are required for Workflow secret slots and are never persisted in a Recipe",
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
