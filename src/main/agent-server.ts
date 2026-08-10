import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { TaskSpaceManager } from "./manager.js";
import { SpaceLeaseRegistry, type SpaceLease } from "./space-lease.js";
import { SnapshotService } from "./snapshot.js";
import { CdpBroker } from "./cdp-broker.js";

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
    private readonly browserVersion = "0.1.4",
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
      case "createTaskSpace": {
        const space = await this.manager.createSpace(String(args[0] || "Agent Space"), "agent");
        await this.select(connection, space.id);
        return space;
      }
      case "claimTaskSpace": {
        const spaceId = Number(args[0]);
        const space = this.manager.getSpaceOrThrow(spaceId);
        await this.manager.setOwnership(spaceId, "agent", "active");
        if (args[1]) await this.manager.renameSpace(spaceId, String(args[1]));
        await this.select(connection, spaceId);
        return this.manager.getSpaceOrThrow(spaceId);
      }
      case "useTaskSpace":
        await this.select(connection, Number(args[0]));
        return Number(args[0]);
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
      case "snapshot": {
        const { spaceId } = this.assertAgentControl(connection);
        return this.snapshotService.snapshot(spaceId, args[0]);
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
    }
    connection.lease = undefined;
  }

  private disconnect(connection: Connection) {
    if (!this.connections.delete(connection.id)) return;
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

function normalizeAgentError(error: any) {
  const raw = error?.message || String(error);
  const known = raw.match(/EGO_[A-Z_]+/)?.[0];
  return {
    code: known || "EGO_OPERATION_FAILED",
    message: raw,
  };
}
