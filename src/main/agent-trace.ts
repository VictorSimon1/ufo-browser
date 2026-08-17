import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskSpaceManager } from "./manager.js";
import {
  redactEventData,
  SpaceEventJournal,
  type SpaceEventListOptions,
} from "./space-event-journal.js";

export type AgentTraceSignal = {
  phase: "started" | "finished";
  stepId?: string;
  action?: string;
  label?: string;
  target?: unknown;
  status?: "success" | "failed";
  durationMs?: number;
  browserDurationMs?: number;
  error?: unknown;
};

export type AgentTraceContext = {
  leaseGeneration?: number;
};

type PendingStep = {
  spaceId: number;
  connectionId: string;
  tabId?: string;
  stepId: string;
  action: string;
  label?: string;
  target?: unknown;
  startedAt: number;
  startSequence: number;
  beforeUrl?: string;
  leaseGeneration?: number;
};

export class AgentTraceService {
  private readonly pending = new Map<string, PendingStep>();

  constructor(
    private readonly journal: SpaceEventJournal,
    private readonly manager: TaskSpaceManager,
  ) {}

  receive(
    connectionId: string,
    spaceId: number,
    signal: AgentTraceSignal,
    context: AgentTraceContext = {},
  ) {
    const stepId = safeStepId(signal.stepId) ?? randomUUID();
    const key = `${connectionId}:${stepId}`;
    const action = safeAction(signal.action);
    const current = currentTab(this.manager, spaceId);
    const tabId = current?.targetId;
    if (signal.phase === "started") {
      const startedAt = Date.now();
      const target = normalizeTraceTarget(action, signal.target);
      const label = safeLabel(signal.label);
      const event = this.journal.append({
        connectionId,
        spaceId,
        tabId,
        stepId,
        category: "action",
        type: "action.started",
        at: startedAt,
        data: {
          action,
          label,
          target: redactTraceTarget(action, target),
          beforeUrl: current?.url,
          leaseGeneration: finiteGeneration(context.leaseGeneration),
        },
      });
      this.pending.set(key, {
        connectionId,
        spaceId,
        tabId,
        stepId,
        action,
        label,
        target,
        startedAt,
        startSequence: event.sequence,
        beforeUrl: current?.url,
        leaseGeneration: finiteGeneration(context.leaseGeneration),
      });
      return event;
    }

    const pending = this.pending.get(key);
    this.pending.delete(key);
    const finishedAt = Date.now();
    const status = signal.status === "failed" ? "failed" : "success";
    const relatedEvents = pending
      ? this.relatedEvents(spaceId, pending)
      : [];
    const error = status === "failed" ? redactEventData(signal.error) : undefined;
    return this.journal.append({
      spaceId,
      connectionId,
      tabId: pending?.tabId ?? tabId,
      stepId,
      category: "action",
      type: "action.finished",
      at: finishedAt,
      data: {
        action: pending?.action ?? action,
        label: pending?.label ?? safeLabel(signal.label),
        target: redactTraceTarget(
          pending?.action ?? action,
          pending?.target ?? normalizeTraceTarget(action, signal.target),
        ),
        leaseGeneration:
          pending?.leaseGeneration ?? finiteGeneration(context.leaseGeneration),
        beforeUrl: pending?.beforeUrl,
        afterUrl: current?.url,
        status,
        durationMs:
          finiteDuration(signal.durationMs) ??
          (pending ? finishedAt - pending.startedAt : undefined),
        browserDurationMs: finiteDuration(signal.browserDurationMs),
        execution: executionSummary(status, error),
        relatedEvents,
        screenshot: screenshotPath(error),
        error,
      },
    });
  }

  disconnect(connectionId: string) {
    const finishedAt = Date.now();
    for (const [key, step] of this.pending) {
      if (step.connectionId !== connectionId) continue;
      this.pending.delete(key);
      this.journal.append({
        spaceId: step.spaceId,
        connectionId,
        tabId: step.tabId,
        stepId: step.stepId,
        category: "action",
        type: "action.finished",
        at: finishedAt,
        data: {
          action: step.action,
          label: step.label,
          target: redactTraceTarget(step.action, step.target),
          leaseGeneration: step.leaseGeneration,
          beforeUrl: step.beforeUrl,
          afterUrl: currentTab(this.manager, step.spaceId)?.url,
          status: "failed",
          durationMs: finishedAt - step.startedAt,
          execution: { outcome: "connection-closed" },
          error: {
            name: "AgentConnectionClosedError",
            message: "Agent connection closed before the action completed",
          },
        },
      });
    }
  }

  list(spaceId: number, options: SpaceEventListOptions = {}) {
    const result = this.journal.list(spaceId, {
      ...options,
      categories: ["action"],
    });
    return result;
  }

  async export(
    spaceId: number,
    options: { format?: "markdown" | "json"; path: string },
  ) {
    if (!options || typeof options.path !== "string" || !options.path.trim()) {
      throw new TypeError("trace export requires an absolute path");
    }
    if (!isAbsolute(options.path)) {
      throw new TypeError("trace export requires an absolute path");
    }
    const format = options.format ?? inferFormat(options.path);
    if (format !== "markdown" && format !== "json") {
      throw new TypeError("trace export format must be markdown or json");
    }
    const events = this.journal.list(spaceId, {
      categories: ["action", "navigation", "network", "console", "dialog", "download", "lifecycle"],
      limit: 1_000,
    }).events;
    const space = this.manager.getSpace(spaceId);
    const content =
      format === "json"
        ? `${JSON.stringify({ space, events }, null, 2)}\n`
        : markdownTrace(space?.name ?? `Space ${spaceId}`, events);
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
    await writeFile(options.path, content, { mode: 0o600 });
    return { path: options.path, format, events: events.length };
  }

  private relatedEvents(spaceId: number, pending: PendingStep) {
    return this.journal
      .list(spaceId, {
        after: pending.startSequence,
        categories: [
          "navigation",
          "network",
          "console",
          "dialog",
          "download",
          "lifecycle",
        ],
        limit: 100,
      })
      .events.filter(
        (event) =>
          !event.tabId || !pending.tabId || event.tabId === pending.tabId,
      )
      .slice(-20)
      .map((event) => ({
        sequence: event.sequence,
        category: event.category,
        type: event.type,
        data: event.data,
      }));
  }
}

function markdownTrace(name: string, events: Array<Record<string, any>>) {
  const lines = [`# ${name} Agent Trace`, "", "| Time | Type | Detail |", "| --- | --- | --- |"];
  for (const event of events) {
    const detail = JSON.stringify(event.data ?? {})
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, " ");
    lines.push(
      `| ${new Date(event.at).toISOString()} | ${event.type} | ${detail} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function safeStepId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : undefined;
}

function safeAction(value: unknown) {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 128 ? trimmed : "unknown";
}

function safeLabel(value: unknown) {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label ? label.slice(0, 256) : undefined;
}

function finiteDuration(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

function finiteGeneration(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function inferFormat(path: string): "markdown" | "json" {
  return extname(path).toLowerCase() === ".json" ? "json" : "markdown";
}

function redactTraceTarget(action: string, target: unknown) {
  const redacted = redactEventData(target);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) {
    return redacted;
  }
  if (/fill|type|insert|upload|secret/i.test(action)) {
    const output = { ...(redacted as Record<string, unknown>) };
    for (const key of Object.keys(output)) {
      if (/value|text|path|body|input/i.test(key)) output[key] = "[redacted]";
    }
    return output;
  }
  return redacted;
}

function normalizeTraceTarget(action: string, value: unknown) {
  const input: Record<string, unknown> =
    value && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : { target: value };
  const selector =
    typeof input.locator === "string"
      ? input.locator
      : typeof input.target === "string"
        ? input.target
        : undefined;
  if (selector) {
    input.locator = selector;
    if (/^@\d+$/.test(selector)) input.ref = selector;
    const semantics = traceSelectorSemantics(selector);
    if (semantics.role && input.role === undefined) input.role = semantics.role;
    if (semantics.name && input.name === undefined) input.name = semantics.name;
    if (semantics.nth !== undefined && input.nth === undefined) {
      input.nth = semantics.nth;
    }
  }
  const semantics =
    input.semantics && typeof input.semantics === "object"
      ? (input.semantics as Record<string, unknown>)
      : undefined;
  if (semantics) {
    for (const key of ["role", "name", "label", "parent", "adjacent", "nth"]) {
      if (input[key] === undefined && semantics[key] !== undefined) {
        input[key] = semantics[key];
      }
    }
  }
  if (/fill|type|insert|upload|secret/i.test(action) && input.value !== undefined) {
    input.value = "[redacted]";
  }
  return input;
}

function traceSelectorSemantics(selector: string) {
  let source = selector;
  let nth: number | undefined;
  const nthMatch = /^internal:nth=(\d+);([\s\S]+)$/.exec(source);
  if (nthMatch) {
    nth = Number(nthMatch[1]);
    source = nthMatch[2];
  }
  const roleMatch = /(?:^|;)loc=role:([^\[;]+)(?:\[name=(.+)\])?$/.exec(
    source,
  );
  return {
    role: roleMatch?.[1],
    name: parseTraceMatcher(roleMatch?.[2]),
    nth,
  };
}

function parseTraceMatcher(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return value.replace(/^['"]|['"]$/g, "");
  }
}

function currentTab(manager: TaskSpaceManager, spaceId: number) {
  const space = manager.getSpace(spaceId);
  if (!space) return undefined;
  const tab = Array.isArray(space.tabs)
    ? space.tabs.find((candidate) => candidate.targetId === space.activeTabId)
    : undefined;
  return tab ??
    (space.activeTabId
      ? { targetId: space.activeTabId, url: undefined }
      : undefined);
}

function executionSummary(status: "success" | "failed", error: unknown) {
  if (status === "success") return { outcome: "completed" };
  const detail =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  return {
    outcome:
      detail.name === "TimeoutError" || /timeout/i.test(String(detail.message ?? ""))
        ? "timeout"
        : "failed",
    reason: detail.reason,
    locator: detail.locator,
    interceptedBy: detail.interceptedBy,
    attempts: detail.attempts,
    recovery: detail.recovery,
  };
}

function screenshotPath(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>).screenshot;
  return typeof value === "string" && isAbsolute(value) ? value : undefined;
}
