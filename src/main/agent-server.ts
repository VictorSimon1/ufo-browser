import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { TaskSpaceManager } from "./manager.js";
import { SpaceLeaseRegistry, type SpaceLease } from "./space-lease.js";
import { SnapshotService } from "./snapshot.js";
import { CdpBroker } from "./cdp-broker.js";
import { AgentTraceService, type AgentTraceSignal } from "./agent-trace.js";
import {
  SpaceEventJournal,
  type SpaceEventCategory,
} from "./space-event-journal.js";
import {
  WorkflowService,
  type WorkflowFinishOptions,
} from "./workflow-service.js";

type Connection = {
  id: string;
  socket: Socket;
  selectedSpaceId?: number;
  lease?: SpaceLease;
  buffer: string;
  queue: Promise<void>;
};

export class AgentServer {
  private readonly server = createServer((socket) => this.accept(socket));
  private readonly connections = new Map<string, Connection>();
  private closePromise?: Promise<void>;

  constructor(
    readonly socketPath: string,
    private readonly manager: TaskSpaceManager,
    private readonly leases: SpaceLeaseRegistry,
    private readonly snapshotService: SnapshotService,
    private readonly broker: CdpBroker,
    private readonly browserVersion = "0.1.6",
    private readonly journal?: SpaceEventJournal,
    private readonly trace?: AgentTraceService,
    private readonly workflows?: WorkflowService,
  ) {}

  async listen() {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await unlink(this.socketPath).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      for (const connection of this.connections.values()) {
        connection.socket.destroy();
      }
      if (this.server.listening) {
        await new Promise<void>((resolve, reject) =>
          this.server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await unlink(this.socketPath).catch(() => undefined);
    })();
    return this.closePromise;
  }

  private accept(socket: Socket) {
    socket.setEncoding("utf8");
    const connection: Connection = {
      id: randomUUID(),
      socket,
      buffer: "",
      queue: Promise.resolve(),
    };
    this.connections.set(connection.id, connection);
    this.broker.registerConnection(connection.id, (payload) => {
      this.write(connection, { type: "cdp-message", payload });
    });
    socket.on("data", (chunk) => this.receive(connection, String(chunk)));
    socket.on("close", () => this.disconnect(connection));
    socket.on("error", () => this.disconnect(connection));
  }

  private receive(connection: Connection, chunk: string) {
    connection.buffer += chunk;
    if (connection.buffer.length > 8 * 1024 * 1024) {
      connection.socket.destroy(new Error("protocol line exceeds 8 MiB"));
      return;
    }
    while (true) {
      const newline = connection.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = connection.buffer.slice(0, newline);
      connection.buffer = connection.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "cdp-send") {
        // CDP is a multiplexed protocol: a paused Fetch request must be able to
        // receive Fetch.continue/fulfill while the originating Runtime.evaluate
        // is still pending. Serializing these by socket creates a hard deadlock.
        void this.handle(connection, message);
      } else {
        connection.queue = connection.queue.then(() =>
          this.handle(connection, message),
        );
      }
    }
  }

  private async handle(connection: Connection, message: any) {
    if (message.type === "trace-event") {
      try {
        const selected = this.assertAgentControl(connection);
        const signal = normalizeTraceSignal(message.payload);
        const event = this.trace?.receive(
          connection.id,
          selected.spaceId,
          signal,
          { leaseGeneration: selected.generation },
        );
        this.workflows?.captureTrace(
          connection.id,
          selected.spaceId,
          signal,
          event,
        );
      } catch {
        // Trace is diagnostic and must never delay or fail the real action.
      }
      return;
    }
    if (message.type === "rpc") {
      try {
        const result = await this.rpc(connection, message.method, message.args ?? []);
        this.write(connection, {
          type: "rpc-result",
          id: message.id,
          result,
        });
      } catch (error: any) {
        const normalized = normalizeAgentError(error);
        this.write(connection, {
          type: "rpc-error",
          id: message.id,
          error: normalized.message,
          error_code: normalized.code,
        });
      }
      return;
    }
    if (message.type === "cdp-send") {
      try {
        const selected = this.assertAgentControl(connection);
        await this.broker.send(
          connection.id,
          selected.spaceId,
          selected.generation,
          String(message.payload),
        );
      } catch (error: any) {
        const normalized = normalizeAgentError(error);
        this.write(connection, {
          type: "cdp-error",
          error: normalized.message,
          error_code: normalized.code,
        });
      }
    }
  }

  private async rpc(connection: Connection, method: string, args: any[]) {
    switch (method) {
      case "listTaskSpaces":
        return { taskSpaces: this.manager.listSpaces() };
      case "listProfiles":
        return { profiles: this.manager.listProfiles() };
      case "bootstrapTaskSpace": {
        const options = bootstrapTaskSpaceOptions(args[0]);
        let createdSpaceId: number | undefined;
        try {
          const space = await this.manager.createSpace(
            options.name,
            "agent",
            options.profileId,
          );
          createdSpaceId = space.id;
          await this.select(connection, space.id);
          if (options.url) {
            await this.manager.createAgentTab(space.id, options.url);
          }
          const verified = this.manager.getSpaceOrThrow(space.id);
          verifyBootstrappedSpace(verified, options.profileId);
          const activeTab = verified.tabs.find(
            (tab) => tab.targetId === verified.activeTabId,
          );
          if (!activeTab) throw new Error("EGO_TASK_SPACE_BOOTSTRAP_FAILED: active tab missing");
          return {
            ...structuredClone(verified),
            url: activeTab.url,
            verified: true,
          };
        } catch (error) {
          if (createdSpaceId !== undefined) {
            if (connection.selectedSpaceId === createdSpaceId) {
              this.release(connection);
              connection.selectedSpaceId = undefined;
            }
            await this.manager.closeSpace(createdSpaceId).catch(() => undefined);
          }
          throw error;
        }
      }
      case "claimTaskSpace": {
        const spaceId = Number(args[0]);
        const space = this.manager.getSpaceOrThrow(spaceId);
        await this.manager.setOwnership(spaceId, "agent", "active");
        if (args[1]) await this.manager.renameSpace(spaceId, String(args[1]));
        await this.select(connection, spaceId);
        return this.manager.getSpaceOrThrow(spaceId);
      }
      case "useTaskSpace": {
        const spaceId = strictSpaceId(args[0], "useTaskSpace");
        const space = this.manager.getSpaceOrThrow(spaceId);
        if (space.lifecycle !== "active") throw new Error("EGO_TASK_SPACE_INACTIVE");
        await this.select(connection, spaceId);
        return structuredClone(this.manager.getSpaceOrThrow(spaceId));
      }
      case "closeTaskSpace": {
        const { spaceId } = this.assertSelected(connection);
        await this.manager.closeSpace(spaceId);
        this.release(connection);
        return { done: true };
      }
      case "createTab": {
        const { spaceId } = this.assertAgentControl(connection);
        if (typeof args[0] !== "string") {
          throw new TypeError(
            "ego.createTab(url) expects a string URL.\n" +
              "Example: await ego.createTab('https://example.com')",
          );
        }
        const tab = await this.manager.createAgentTab(spaceId, args[0]);
        return { targetId: tab.targetId };
      }
      case "listTabs": {
        const { spaceId } = this.assertAgentControl(connection);
        const space = this.manager.getSpaceOrThrow(spaceId);
        return {
          tabs: space.tabs.map((tab) => ({
            ...tab,
            type: "page",
            active: tab.targetId === space.activeTabId,
          })),
        };
      }
      case "listSpaceEvents": {
        const { spaceId } = this.assertAgentControl(connection);
        assertRequestedSpace(spaceId, args[0], "listSpaceEvents");
        return this.journal?.list(spaceId, eventListOptions(args[1])) ?? {
          events: [],
          nextSequence: 0,
          cursorExpired: false,
          latestSequence: 0,
        };
      }
      case "listAgentTrace": {
        const { spaceId } = this.assertAgentControl(connection);
        assertRequestedSpace(spaceId, args[0], "listAgentTrace");
        return this.trace?.list(spaceId, eventListOptions(args[1])) ?? {
          events: [],
          nextSequence: 0,
          cursorExpired: false,
          latestSequence: 0,
        };
      }
      case "exportAgentTrace": {
        const { spaceId } = this.assertAgentControl(connection);
        assertRequestedSpace(spaceId, args[0], "exportAgentTrace");
        if (!this.trace) throw new Error("EGO_OPERATION_FAILED: trace unavailable");
        return this.trace.export(spaceId, traceExportOptions(args[1]));
      }
      case "startWorkflowRecording": {
        const { spaceId } = this.assertAgentControl(connection);
        if (!this.workflows) {
          throw new Error("EGO_OPERATION_FAILED: workflows unavailable");
        }
        return this.workflows.start(connection.id, spaceId, args[0]);
      }
      case "finishWorkflowRecording": {
        const { spaceId } = this.assertAgentControl(connection);
        if (!this.workflows) {
          throw new Error("EGO_OPERATION_FAILED: workflows unavailable");
        }
        return this.workflows.finish(
          connection.id,
          spaceId,
          args[0],
          workflowFinishOptions(args[1]),
        );
      }
      case "cancelWorkflowRecording": {
        const { spaceId } = this.assertAgentControl(connection);
        if (!this.workflows) {
          throw new Error("EGO_OPERATION_FAILED: workflows unavailable");
        }
        return this.workflows.cancel(connection.id, spaceId, args[0]);
      }
      case "listWorkflows": {
        this.assertAgentControl(connection);
        return this.workflows?.list() ?? { workflows: [], limit: 0 };
      }
      case "getWorkflow": {
        this.assertAgentControl(connection);
        if (!this.workflows) {
          throw new Error("EGO_OPERATION_FAILED: workflows unavailable");
        }
        return this.workflows.get(args[0], args[1]);
      }
      case "prepareWorkflowReplay": {
        const { spaceId } = this.assertAgentControl(connection);
        if (!this.workflows) {
          throw new Error("EGO_OPERATION_FAILED: workflows unavailable");
        }
        return this.workflows.prepareReplay(
          connection.id,
          spaceId,
          args[0],
          workflowReplayOptions(args[1]),
        );
      }
      case "finishWorkflowReplay": {
        const { spaceId } = this.assertAgentControl(connection);
        if (!this.workflows) {
          throw new Error("EGO_OPERATION_FAILED: workflows unavailable");
        }
        return this.workflows.finishReplay(
          connection.id,
          spaceId,
          args[0],
          workflowReplayResult(args[1]),
        );
      }
      case "snapshot": {
        const { spaceId } = this.assertAgentControl(connection);
        return this.snapshotService.snapshot(spaceId, args[0]);
      }
      case "resolveRef": {
        const { spaceId } = this.assertAgentControl(connection);
        return this.snapshotService.resolveHistoricalRef(
          spaceId,
          Number(args[0]),
        );
      }
      case "handOffTaskSpace": {
        const { spaceId } = this.assertAgentControl(connection);
        await this.manager.setOwnership(spaceId, "agentDelegatedToUser", "active");
        this.release(connection);
        return { done: true };
      }
      case "takeOverTaskSpace": {
        const { spaceId } = this.assertSelected(connection);
        await this.manager.setOwnership(spaceId, "agent", "active");
        await this.select(connection, spaceId);
        return { done: true };
      }
      case "completeTaskSpace": {
        const { spaceId } = this.assertAgentControl(connection);
        await this.manager.setLifecycle(spaceId, "completed");
        this.release(connection);
        return { done: true };
      }
      case "markTaskSpaceError": {
        const { spaceId } = this.assertSelected(connection);
        await this.manager.setLifecycle(spaceId, "error");
        this.release(connection);
        return { done: true };
      }
      case "setAgentTaskState": {
        const { spaceId } = this.assertAgentControl(connection);
        await this.manager.setAgentTaskState(spaceId, args[0] ?? {});
        return { done: true };
      }
      case "animationHighlightMouseToPosition": {
        const { spaceId } = this.assertAgentControl(connection);
        this.manager.showAgentPointer(
          spaceId,
          Number(args[0]),
          Number(args[1]),
        );
        return { done: true };
      }
      case "getBrowserVersion":
        return {
          currentVersion: this.browserVersion,
          updateAvailable: false,
        };
      default:
        throw new Error(`EGO_INVALID_ARGUMENT: unknown method ${method}`);
    }
  }

  private async select(connection: Connection, spaceId: number) {
    const space = this.manager.getSpaceOrThrow(spaceId);
    if (space.lifecycle !== "active") throw new Error("EGO_TASK_SPACE_INACTIVE");
    if (connection.selectedSpaceId !== spaceId) this.release(connection);
    connection.selectedSpaceId = spaceId;
    // Selection is not ownership. A user-owned or handed-off Space can be
    // selected so an explicitly authorized takeOverTaskSpace(id) can target it,
    // but it receives no lease and all page operations remain hard-stopped.
    if (space.ownership !== "agent") {
      if (connection.lease) {
        this.release(connection);
        connection.selectedSpaceId = spaceId;
      }
      return;
    }
    const lease = this.leases.acquire(spaceId, connection.id);
    connection.lease = lease;
    this.manager.setAgentConnectionActive(spaceId, true);
    this.journal?.append({
      spaceId,
      connectionId: connection.id,
      tabId: space.activeTabId,
      category: "lifecycle",
      type: "agent.connected",
      data: { generation: lease.generation },
    });
  }

  private assertSelected(connection: Connection) {
    if (!connection.selectedSpaceId) throw new Error("EGO_TASK_SPACE_NOT_SELECTED");
    return { spaceId: connection.selectedSpaceId };
  }

  private assertAgentControl(connection: Connection) {
    const { spaceId } = this.assertSelected(connection);
    const space = this.manager.getSpaceOrThrow(spaceId);
    if (space.lifecycle !== "active") throw new Error("EGO_TASK_SPACE_INACTIVE");
    if (space.ownership !== "agent") throw new Error("EGO_TASK_SPACE_USER_IN_CONTROL");
    if (!connection.lease) throw new Error("EGO_TASK_SPACE_UNAVAILABLE");
    this.leases.assert(spaceId, connection.id, connection.lease.generation);
    return { spaceId, generation: connection.lease.generation };
  }

  private release(connection: Connection) {
    if (connection.selectedSpaceId) {
      const spaceId = connection.selectedSpaceId;
      this.broker.releaseConnectionSpace(
        connection.id,
        spaceId,
      );
      this.manager.setAgentConnectionActive(spaceId, false);
      this.leases.release(spaceId, connection.id);
      if (this.journal && this.manager.getSpace(spaceId)) {
        this.journal?.append({
          spaceId,
          connectionId: connection.id,
          category: "lifecycle",
          type: "agent.released",
        });
      }
    }
    connection.lease = undefined;
  }

  private disconnect(connection: Connection) {
    if (!this.connections.delete(connection.id)) return;
    this.trace?.disconnect(connection.id);
    this.workflows?.disconnect(connection.id);
    this.release(connection);
    this.leases.releaseConnection(connection.id);
    this.broker.removeConnection(connection.id);
  }

  private write(connection: Connection, message: unknown) {
    if (!connection.socket.destroyed) {
      connection.socket.write(`${JSON.stringify(message)}\n`);
    }
  }
}

function workflowFinishOptions(value: unknown): WorkflowFinishOptions {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("workflow finish options must be an object");
  }
  const input = value as Record<string, unknown>;
  return { variables: input.variables as any, secrets: input.secrets as any };
}

function workflowReplayOptions(value: unknown) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("workflow replay options must be an object");
  }
  return { version: (value as Record<string, unknown>).version };
}

function workflowReplayResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("workflow replay result must be an object");
  }
  const input = value as Record<string, unknown>;
  return { status: input.status, durationMs: input.durationMs };
}

function normalizeTraceSignal(value: unknown): AgentTraceSignal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid trace signal");
  }
  const signal = value as Record<string, unknown>;
  if (signal.phase !== "started" && signal.phase !== "finished") {
    throw new TypeError("invalid trace phase");
  }
  return {
    phase: signal.phase,
    stepId: typeof signal.stepId === "string" ? signal.stepId : undefined,
    action: typeof signal.action === "string" ? signal.action : undefined,
    label: typeof signal.label === "string" ? signal.label : undefined,
    target: signal.target,
    status:
      signal.status === "failed" || signal.status === "success"
        ? signal.status
        : undefined,
    durationMs: Number(signal.durationMs),
    browserDurationMs: Number(signal.browserDurationMs),
    error: signal.error,
  };
}

function assertRequestedSpace(
  selectedSpaceId: number,
  value: unknown,
  operation: string,
) {
  const requested = strictSpaceId(value, operation);
  if (requested !== selectedSpaceId) {
    throw new Error("EGO_TASK_SPACE_UNAVAILABLE");
  }
}

function eventListOptions(value: unknown) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("event list options must be an object");
  }
  const input = value as Record<string, unknown>;
  const categories = Array.isArray(input.categories)
    ? input.categories
        .filter((item): item is string => typeof item === "string")
        .filter((item): item is SpaceEventCategory =>
          [
            "action",
            "navigation",
            "network",
            "console",
            "dialog",
            "download",
            "lifecycle",
            "trace",
          ].includes(item),
        )
    : undefined;
  return {
    after: Number(input.after),
    limit: Number(input.limit),
    categories,
  };
}

function traceExportOptions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("trace export expects { path, format? }");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.path !== "string" || !input.path.trim()) {
    throw new TypeError("trace export path must be a non-empty string");
  }
  if (
    input.format !== undefined &&
    input.format !== "markdown" &&
    input.format !== "json" &&
    input.format !== "zip"
  ) {
    throw new TypeError("trace export format must be markdown, json, or zip");
  }
  return {
    path: input.path,
    format: input.format as "markdown" | "json" | "zip" | undefined,
  };
}

function bootstrapTaskSpaceOptions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      "bootstrapTaskSpace expects { name, profileId?, url? }",
    );
  }
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new TypeError("bootstrapTaskSpace name must be a non-empty string");
  }
  return {
    name: input.name.trim(),
    profileId: optionalString(input.profileId, "bootstrapTaskSpace profileId"),
    url: optionalString(input.url, "bootstrapTaskSpace url"),
  };
}

function optionalString(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function strictSpaceId(value: unknown, operation: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${operation} expects a positive numeric Space ID`);
  }
  return value;
}

function verifyBootstrappedSpace(
  space: {
    profileId: string;
    profileMode: string;
    sessionScopeId?: string;
    lifecycle: string;
    ownership: string;
  },
  requestedProfileId?: string,
) {
  if (space.lifecycle !== "active" || space.ownership !== "agent") {
    throw new Error("EGO_TASK_SPACE_BOOTSTRAP_FAILED: Space is not active");
  }
  const temporary = requestedProfileId?.toLowerCase() === "temporary";
  if (temporary) {
    if (
      space.profileId !== "temporary" ||
      space.profileMode !== "temporary" ||
      !space.sessionScopeId
    ) {
      throw new Error(
        "EGO_TASK_SPACE_BOOTSTRAP_FAILED: Temporary Profile Session was not created",
      );
    }
  } else if (space.profileMode !== "persistent" || space.sessionScopeId) {
    throw new Error(
      "EGO_TASK_SPACE_BOOTSTRAP_FAILED: persistent Profile Session is invalid",
    );
  }
}

function normalizeAgentError(error: any) {
  const raw = error?.message || String(error);
  const known = raw.match(/EGO_[A-Z_]+/)?.[0];
  return {
    code: known || "EGO_OPERATION_FAILED",
    message: raw,
  };
}
