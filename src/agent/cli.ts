import type { Socket } from "node:net";
import {
  assertEgoCreateTabUrl,
  createEgoCompatibilityContext,
  formatCliLogValue,
  installEgoCompatibilityGlobals,
} from "./compat.js";
import * as runtime from "./runtime/helpers.js";
import {
  connectAgentSocket,
  resolveSocketCandidates,
} from "./socket-path.js";
import { assertRawCdpPayload } from "./raw-cdp.js";

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

class AgentHost {
  onCDPMessage?: (payload: string) => void;
  onSendCDPMessageError?: (message: string, errorCode?: string) => void;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private activeWorkflowRecordingId?: string;

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.receive(String(chunk)));
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("EGO_TASK_HOST_DISCONNECTED"));
      }
      this.pending.clear();
    });
  }

  listTaskSpaces = () => this.rpc("listTaskSpaces");
  listProfiles = () => this.rpc("listProfiles");
  bootstrapTaskSpace = (options: {
    name: string;
    profileId?: string;
    url?: string;
  }) => this.rpc("bootstrapTaskSpace", options);
  claimTaskSpace = (id: number, name?: string) =>
    this.rpc("claimTaskSpace", id, name);
  useTaskSpace = (id: number) => this.rpc("useTaskSpace", id);
  closeTaskSpace = () => this.rpc("closeTaskSpace");
  createTab = (url?: string) => {
    assertEgoCreateTabUrl(url);
    return this.rpc("createTab", url);
  };
  listTabs = () => this.rpc("listTabs");
  listSpaceEvents = (spaceId: number, options?: unknown) =>
    this.rpc("listSpaceEvents", spaceId, options);
  listAgentTrace = (spaceId: number, options?: unknown) =>
    this.rpc("listAgentTrace", spaceId, options);
  exportAgentTrace = (spaceId: number, options: unknown) =>
    this.rpc("exportAgentTrace", spaceId, options);
  startWorkflowRecording = async (name: string) => {
    const recording: any = await this.rpc("startWorkflowRecording", name);
    this.activeWorkflowRecordingId = recording.id;
    return recording;
  };
  finishWorkflowRecording = async (recordingId: string, options?: unknown) => {
    const recipe = await this.rpc(
      "finishWorkflowRecording",
      recordingId,
      options,
    );
    if (this.activeWorkflowRecordingId === recordingId) {
      this.activeWorkflowRecordingId = undefined;
    }
    return recipe;
  };
  cancelWorkflowRecording = async (recordingId: string) => {
    const result = await this.rpc("cancelWorkflowRecording", recordingId);
    if (this.activeWorkflowRecordingId === recordingId) {
      this.activeWorkflowRecordingId = undefined;
    }
    return result;
  };
  listWorkflows = () => this.rpc("listWorkflows");
  getWorkflow = (name: string, version?: number) =>
    this.rpc("getWorkflow", name, version);
  prepareWorkflowReplay = (name: string, options?: unknown) =>
    this.rpc("prepareWorkflowReplay", name, options);
  finishWorkflowReplay = (runId: string, result: unknown) =>
    this.rpc("finishWorkflowReplay", runId, result);
  snapshot = (options?: unknown) => this.rpc("snapshot", options);
  resolveRef = (refId: number) => this.rpc("resolveRef", refId);
  handOffTaskSpace = () => this.rpc("handOffTaskSpace");
  takeOverTaskSpace = () => this.rpc("takeOverTaskSpace");
  completeTaskSpace = () => this.rpc("completeTaskSpace");
  markTaskSpaceError = () => this.rpc("markTaskSpaceError");
  setAgentTaskState = (state: unknown) => this.rpc("setAgentTaskState", state);
  animationHighlightMouseToPosition = (...args: unknown[]) =>
    this.rpc("animationHighlightMouseToPosition", ...args);
  getBrowserVersion = () => this.rpc("getBrowserVersion");

  isWorkflowRecordingActive() {
    return Boolean(this.activeWorkflowRecordingId);
  }

  traceEvent = (payload: unknown) => {
    this.write({ type: "trace-event", payload });
  };

  sendCDPMessage = (payload: string) => {
    this.write({ type: "cdp-send", payload: assertRawCdpPayload(payload) });
  };

  close() {
    this.socket.end();
  }

  private rpc(method: string, ...args: unknown[]) {
    const id = this.nextId++;
    this.write({ type: "rpc", id, method, args });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.type === "rpc-result" || message.type === "rpc-error") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.type === "rpc-result") pending.resolve(message.result);
        else {
          const error: any = new Error(message.error);
          error.error_code = message.error_code;
          pending.reject(error);
        }
      } else if (message.type === "cdp-message") {
        this.onCDPMessage?.(message.payload);
      } else if (message.type === "cdp-error") {
        this.onSendCDPMessageError?.(message.error, message.error_code);
      }
    }
  }

  private write(message: unknown) {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }
}

const { socket } = await connectAgentSocket(resolveSocketCandidates());
const host = new AgentHost(socket);
(globalThis as any).ego = host;

try {
  process.exitCode = await runCompatibleMain(runtime);
} catch (error: any) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
} finally {
  host.close();
}

async function runCompatibleMain(harness: Record<string, any>) {
  const argv = process.argv.slice(2).filter((arg: string) => arg !== "nodejs");
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(
      "ufo-browser nodejs <<'EOF'\nconst task = await bootstrapTaskSpace({ name: 'task', url: 'https://example.com/' })\ncliLog(task)\nEOF\n",
    );
    return 0;
  }
  if (argv.length > 0) {
    process.stderr.write("Usage: ufo-browser nodejs <<'EOF' ... EOF\n");
    return 2;
  }
  const code = await readStdin();
  if (!code.trim()) {
    process.stderr.write("Usage: ufo-browser nodejs <<'EOF' ... EOF\n");
    return 2;
  }
  const directLog = (...values: unknown[]) => consoleOutput(...values);
  console.log = directLog;
  const extra =
    typeof harness.loadAgentHelpers === "function"
      ? await harness.loadAgentHelpers()
      : {};
  const modern = harness.helperContext(extra);
  const context = createEgoCompatibilityContext(
    modern,
    harness,
    directLog,
    host,
  );
  instrumentAgentActions(context, host);
  installEgoCompatibilityGlobals(globalThis, context);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  // Ego installs helpers as globals instead of declaring one function
  // parameter per helper. Matching that execution model lets ordinary scripts
  // shadow names such as `screenshot` or `count` with local const bindings,
  // while the unshadowed helper identifiers remain directly callable.
  const fn = new AsyncFunction(`"use strict";\n${code}`);
  await fn();
  if (typeof harness.stopScreencast === "function") {
    await harness.stopScreencast();
  }
  return 0;
}

function instrumentAgentActions(context: Record<string, any>, host: AgentHost) {
  const actions = [
    "click",
    "doubleClick",
    "hover",
    "dragMouse",
    "scroll",
    "fillInput",
    "typeText",
    "pressKey",
    "uploadFile",
    "gotoAndWait",
    "openOrReuseTab",
    "switchTab",
    "closeTab",
    "snapshotText",
    "captureScreenshot",
  ];
  for (const action of actions) {
    if (typeof context[action] !== "function") continue;
    context[action] = tracedAction(host, action, context[action], (...args) =>
      summarizeTopLevelActionTarget(
        context,
        host,
        action,
        args,
      ),
    );
  }
  if (context.page && typeof context.page === "object") {
    for (const action of [
      "goto",
      "reload",
      "snapshot",
      "snapshotRaw",
      "screenshot",
      "waitForEvent",
      "waitForURL",
      "waitForLoadState",
    ]) {
      if (typeof context.page[action] !== "function") continue;
      const original = context.page[action].bind(context.page);
      const operation =
        action === "waitForEvent"
          ? async (...args: any[]) => {
              const result = await original(...args);
              if (args[0] === "popup" && result && typeof result === "object") {
                instrumentPageLocators(result, host, "popup");
              }
              return result;
            }
          : original;
      context.page[action] = tracedAction(
        host,
        `page.${action}`,
        operation,
        (...args) =>
          summarizeActionTarget(
            `page.${action}`,
            args,
            host.isWorkflowRecordingActive(),
          ),
      );
    }
    instrumentPageLocators(context.page, host);
  }
  if (context.site && typeof context.site === "object") {
    for (const action of ["runTool", "runBrowserTool"]) {
      if (typeof context.site[action] !== "function") continue;
      context.site[action] = tracedAction(
        host,
        `site.${action}`,
        context.site[action],
        (...args) => ({
          siteId: summarizeValue(args[0]),
          toolName: summarizeValue(args[1]),
          args: host.isWorkflowRecordingActive() ? args[2] : "[redacted]",
        }),
      );
    }
  }
}

function summarizeTopLevelActionTarget(
  context: Record<string, any>,
  host: AgentHost,
  action: string,
  args: any[],
) {
  const details: any = summarizeActionTarget(
    action,
    args,
    host.isWorkflowRecordingActive(),
  );
  if (
    !host.isWorkflowRecordingActive() ||
    typeof args[0] !== "string" ||
    ![
      "click",
      "doubleClick",
      "fillInput",
    ].includes(action) ||
    typeof context.page?.locator !== "function"
  ) {
    return details;
  }
  return inspectLocatorSemantics(context.page.locator(args[0])).then(
    (semantics) => ({ ...details, semantics }),
  );
}

function tracedAction(
  host: AgentHost,
  action: string,
  operation: (...args: any[]) => any,
  targetFactory: (...args: any[]) => unknown = (...args) =>
    summarizeActionTarget(action, args, host.isWorkflowRecordingActive()),
) {
  return async (...args: any[]) => {
    const stepId = `${process.pid}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 9)}`;
    const startedAt = performance.now();
    let target: unknown;
    try {
      const candidate = targetFactory(...args);
      target = isPromiseLike(candidate)
        ? await candidate.catch(() =>
            summarizeActionTarget(
              action,
              args,
              host.isWorkflowRecordingActive(),
            ),
          )
        : candidate;
    } catch {
      target = summarizeActionTarget(
        action,
        args,
        host.isWorkflowRecordingActive(),
      );
    }
    host.traceEvent({
      phase: "started",
      stepId,
      action,
      label: actionLabel(action, args),
      target,
    });
    const browserStartedAt = performance.now();
    try {
      const result = await operation(...args);
      host.traceEvent({
        phase: "finished",
        stepId,
        action,
        status: "success",
        durationMs: performance.now() - startedAt,
        browserDurationMs: performance.now() - browserStartedAt,
      });
      return result;
    } catch (error: any) {
      host.traceEvent({
        phase: "finished",
        stepId,
        action,
        status: "failed",
        durationMs: performance.now() - startedAt,
        browserDurationMs: performance.now() - browserStartedAt,
        error: summarizeTraceError(error),
      });
      throw error;
    }
  };
}

function actionLabel(action: string, args: any[]) {
  if (action.startsWith("site.")) return undefined;
  const options = args.at(-1);
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return undefined;
  }
  return typeof options.label === "string"
    ? options.label.trim().slice(0, 256)
    : undefined;
}

function summarizeTraceError(error: any) {
  if (!error || typeof error !== "object") {
    return { name: "Error", message: String(error) };
  }
  const output: Record<string, unknown> = {
    name: typeof error.name === "string" ? error.name : "Error",
    code:
      typeof error.code === "string"
        ? error.code
        : typeof error.error_code === "string"
          ? error.error_code
          : undefined,
    message:
      typeof error.message === "string" ? error.message.slice(0, 4_096) : String(error),
  };
  for (const key of [
    "locator",
    "reason",
    "interceptedBy",
    "attempts",
    "recovery",
    "callLog",
    "screenshot",
  ]) {
    if (error[key] !== undefined) output[key] = summarizeValue(error[key]);
  }
  return output;
}

function summarizeActionTarget(
  action: string,
  args: any[],
  includeRecordedValue = false,
) {
  if (
    action === "fillInput" ||
    action === "typeText" ||
    action === "locator.fill"
  ) {
    return {
      target: summarizeValue(args[0]),
      value: includeRecordedValue ? args[1] : "[redacted]",
    };
  }
  if (action === "uploadFile") {
    return { target: summarizeValue(args[0]), path: "[redacted]" };
  }
  if (action === "pressKey") return { key: summarizeValue(args[0]) };
  if (action === "gotoAndWait" || action === "page.goto") {
    return { url: summarizeValue(args[0]) };
  }
  if (action === "page.waitForEvent") {
    return { eventName: summarizeValue(args[0]) };
  }
  if (action.includes("snapshot") || action.includes("Screenshot")) return {};
  return { target: summarizeValue(args[0]) };
}

function instrumentPageLocators(
  page: Record<string, any>,
  host: AgentHost,
  pageContext: "page" | "popup" = "page",
) {
  const locatorCache = new WeakMap<object, any>();
  const frameCache = new WeakMap<object, any>();
  const locatorBuilders = [
    "locator",
    "getByRole",
    "getByText",
    "getByLabel",
    "getByPlaceholder",
    "getByAltText",
    "getByTitle",
    "getByTestId",
    "filter",
    "all",
    "first",
    "last",
    "nth",
  ];
  const locatorActions: Record<string, string> = {
    click: "locator.click",
    dblclick: "locator.dblclick",
    fill: "locator.fill",
    clear: "locator.fill",
    press: "locator.press",
    check: "locator.check",
    uncheck: "locator.uncheck",
    setChecked: "locator.check",
    selectOption: "locator.selectOption",
    setInputFiles: "locator.setInputFiles",
    dragTo: "locator.dragTo",
  };

  const wrapLocator = (value: any): any => {
    if (!value || typeof value !== "object") return value;
    const cached = locatorCache.get(value);
    if (cached) return cached;
    locatorCache.set(value, value);
    for (const name of locatorBuilders) {
      if (typeof value[name] !== "function") continue;
      const original = value[name].bind(value);
      value[name] = (...args: any[]) => {
        const result = original(...args);
        if (name === "all" && result && typeof result.then === "function") {
          return result.then((items: any[]) => items.map(wrapLocator));
        }
        return wrapLocator(result);
      };
    }
    for (const [name, action] of Object.entries(locatorActions)) {
      if (typeof value[name] !== "function") continue;
      const original = value[name].bind(value);
      value[name] = tracedAction(host, action, original, (...args) => {
        const details: Record<string, unknown> = {
          locator: String(value.selector ?? ""),
          pageContext,
        };
        if (action === "locator.fill") {
          details.value = host.isWorkflowRecordingActive()
            ? name === "clear"
              ? ""
              : args[0]
            : "[redacted]";
        } else if (action === "locator.press") {
          details.key = args[0];
        } else if (action === "locator.selectOption") {
          details.value = host.isWorkflowRecordingActive()
            ? args[0]
            : "[redacted]";
        } else if (action === "locator.check" && name === "setChecked") {
          details.checked = Boolean(args[0]);
        }
        if (host.isWorkflowRecordingActive()) {
          return inspectLocatorSemantics(value).then((semantics) => ({
            ...details,
            semantics,
          }));
        }
        return details;
      });
    }
    return value;
  };

  const wrapFrame = (value: any): any => {
    if (!value || typeof value !== "object") return value;
    const cached = frameCache.get(value);
    if (cached) return cached;
    frameCache.set(value, value);
    for (const name of locatorBuilders) {
      if (typeof value[name] !== "function") continue;
      const original = value[name].bind(value);
      value[name] = (...args: any[]) => {
        const result = original(...args);
        return name === "first" || name === "last" || name === "nth"
          ? wrapFrame(result)
          : wrapLocator(result);
      };
    }
    if (typeof value.frameLocator === "function") {
      const original = value.frameLocator.bind(value);
      value.frameLocator = (...args: any[]) => wrapFrame(original(...args));
    }
    return value;
  };

  for (const name of locatorBuilders.filter((item) => item !== "filter")) {
    if (typeof page[name] !== "function") continue;
    const original = page[name].bind(page);
    page[name] = (...args: any[]) => wrapLocator(original(...args));
  }
  if (typeof page.frameLocator === "function") {
    const original = page.frameLocator.bind(page);
    page.frameLocator = (...args: any[]) => wrapFrame(original(...args));
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as Promise<unknown>).then === "function",
  );
}

async function inspectLocatorSemantics(locator: Record<string, any>) {
  if (typeof locator.evaluate !== "function") return undefined;
  return locator.evaluate((element: Element) => {
    const text = (value: unknown, max = 256) =>
      String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max) || undefined;
    const roleOf = (node: Element | null) => {
      if (!node) return undefined;
      const explicit = node.getAttribute("role");
      if (explicit) return explicit;
      const tag = node.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && node.hasAttribute("href")) return "link";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "form") return "form";
      if (tag === "fieldset") return "group";
      if (tag === "input") {
        const type = (node.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (["button", "submit", "reset"].includes(type)) return "button";
        return "textbox";
      }
      return undefined;
    };
    const label =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? text(Array.from(element.labels || []).map((item) => item.innerText).join(" "))
        : undefined;
    const name = text(
      element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        label ||
        (element instanceof HTMLInputElement ? element.placeholder : "") ||
        element.textContent,
    );
    const parentNode = element.closest(
      "[role], fieldset, form, section, article, nav, main, aside",
    );
    const parent =
      parentNode && parentNode !== element
        ? {
            role: roleOf(parentNode),
            name: text(
              parentNode.getAttribute("aria-label") ||
                parentNode.querySelector("legend, h1, h2, h3, h4")?.textContent,
            ),
          }
        : undefined;
    return {
      role: roleOf(element),
      name,
      label,
      parent,
      pageUrl: location.href,
      adjacent: {
        before: text(element.previousElementSibling?.textContent),
        after: text(element.nextElementSibling?.textContent),
      },
    };
  });
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 512);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 4).map(summarizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/value|text|body|password|token|secret/i.test(key))
        .slice(0, 12)
        .map(([key, child]) => [key, summarizeValue(child)]),
    );
  }
  return undefined;
}

function readStdin() {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function consoleOutput(...values: unknown[]) {
  process.stdout.write(`${values.map(formatCliLogValue).join(" ")}\n`);
}
