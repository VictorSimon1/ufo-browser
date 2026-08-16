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
    context[action] = tracedAction(host, action, context[action]);
  }
  if (context.page && typeof context.page === "object") {
    for (const action of ["goto", "reload", "snapshot", "snapshotRaw", "screenshot"]) {
      if (typeof context.page[action] !== "function") continue;
      context.page[action] = tracedAction(
        host,
        `page.${action}`,
        context.page[action],
      );
    }
  }
}

function tracedAction(
  host: AgentHost,
  action: string,
  operation: (...args: any[]) => any,
) {
  return async (...args: any[]) => {
    const stepId = `${process.pid}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 9)}`;
    const startedAt = performance.now();
    host.traceEvent({
      phase: "started",
      stepId,
      action,
      target: summarizeActionTarget(action, args),
    });
    try {
      const result = await operation(...args);
      host.traceEvent({
        phase: "finished",
        stepId,
        action,
        status: "success",
        durationMs: performance.now() - startedAt,
      });
      return result;
    } catch (error: any) {
      host.traceEvent({
        phase: "finished",
        stepId,
        action,
        status: "failed",
        durationMs: performance.now() - startedAt,
        error: error?.message || String(error),
      });
      throw error;
    }
  };
}

function summarizeActionTarget(action: string, args: any[]) {
  if (action === "fillInput" || action === "typeText") {
    return { target: summarizeValue(args[0]), value: "[redacted]" };
  }
  if (action === "uploadFile") {
    return { target: summarizeValue(args[0]), path: "[redacted]" };
  }
  if (action === "pressKey") return { key: summarizeValue(args[0]) };
  if (action.includes("snapshot") || action.includes("Screenshot")) return {};
  return { target: summarizeValue(args[0]) };
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
