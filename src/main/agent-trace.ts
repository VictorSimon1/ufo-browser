import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
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
  target?: unknown;
  status?: "success" | "failed";
  durationMs?: number;
  error?: unknown;
};

type PendingStep = {
  spaceId: number;
  connectionId: string;
  tabId?: string;
  stepId: string;
  action: string;
  startedAt: number;
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
  ) {
    const stepId = safeStepId(signal.stepId) ?? randomUUID();
    const key = `${connectionId}:${stepId}`;
    const action = safeAction(signal.action);
    const tabId = this.manager.getSpace(spaceId)?.activeTabId;
    if (signal.phase === "started") {
      const startedAt = Date.now();
      this.pending.set(key, {
        connectionId,
        spaceId,
        tabId,
        stepId,
        action,
        startedAt,
      });
      return this.journal.append({
        spaceId,
        connectionId,
        tabId,
        stepId,
        category: "action",
        type: "action.started",
        at: startedAt,
        data: {
          action,
          target: redactTraceTarget(action, signal.target),
        },
      });
    }

    const pending = this.pending.get(key);
    this.pending.delete(key);
    const finishedAt = Date.now();
    const status = signal.status === "failed" ? "failed" : "success";
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
        status,
        durationMs:
          finiteDuration(signal.durationMs) ??
          (pending ? finishedAt - pending.startedAt : undefined),
        error:
          status === "failed" ? redactEventData(signal.error) : undefined,
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
          status: "failed",
          durationMs: finishedAt - step.startedAt,
          error: "Agent connection closed before the action completed",
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

function finiteDuration(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
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
