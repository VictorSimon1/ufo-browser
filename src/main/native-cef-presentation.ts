import { createServer, type Server } from "node:net";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { NativeCefOverview, NativeCefOverviewPresentation } from "./native-cef-overview.js";
import type { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";

export type NativeCefPresentationState =
  | { kind: "overview" }
  | { kind: "space"; spaceId: number };

export type NativeCefAgentControl = {
  revokeSpace(spaceId: number): void;
};

/** Single owner for the visible native CEF surface. */
export class NativeCefPresentationCoordinator implements NativeCefOverviewPresentation {
  private state: NativeCefPresentationState = { kind: "overview" };
  private server?: Server;
  private agentControl?: NativeCefAgentControl;

  constructor(
    private readonly manager: NativeCefTaskSpaceManager,
    private readonly overview: NativeCefOverview,
    private readonly socketPath?: string,
  ) {}

  setAgentControl(control: NativeCefAgentControl | undefined) {
    this.agentControl = control;
  }

  /** Start the small AppKit-to-UFO presentation channel used by the native
   * Spaces button. The browser shell never calls the Agent socket directly. */
  async start() {
    if (!this.socketPath || this.server) return;
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await unlink(this.socketPath).catch(() => undefined);
    this.server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const command = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        void this.handleShellCommand(command).then(
          () => { socket.end("ok\n"); },
          (error) => { socket.end(`error ${String(error instanceof Error ? error.message : error)}\n`); },
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
  }

  async stop() {
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    if (this.socketPath) await unlink(this.socketPath).catch(() => undefined);
  }

  async openSpace(spaceId: number) {
    await this.manager.presentSpace(spaceId);
    await this.overview.hideWindow();
    this.state = { kind: "space", spaceId };
  }

  async showOverview() {
    await this.manager.hideRunningSpaces();
    await this.overview.showWindow();
    await this.overview.focusWindow();
    this.state = { kind: "overview" };
  }

  async closeSpace(spaceId: number) {
    const closed = await this.manager.closeSpace(spaceId);
    if (closed && this.state.kind === "space" && this.state.spaceId === spaceId) {
      await this.showOverview();
    }
    return closed;
  }

  async onSpaceClosed(spaceId: number) {
    if (this.state.kind === "space" && this.state.spaceId === spaceId) {
      await this.showOverview();
    }
  }

  async onSpaceStateChanged(spaceId: number) {
    // Handoff/completion should return an already-running Space to the human;
    // if Overview is currently visible, do not unexpectedly steal focus.
    if (this.state.kind === "space" && this.state.spaceId === spaceId) {
      await this.manager.showSpace(spaceId).catch(() => undefined);
    }
  }

  getState() {
    return this.state;
  }

  private async handleShellCommand(command: string) {
    if (command === "show-overview") {
      await this.showOverview();
      return;
    }
    if (command.startsWith("{")) {
      const message = JSON.parse(command);
      const spaceId = Number(message?.spaceId);
      if (!Number.isInteger(spaceId) || spaceId <= 0) {
        throw new Error("invalid Space id");
      }
      if (this.state.kind !== "space" || this.state.spaceId !== spaceId) {
        throw new Error("Space is not presented");
      }
      if (message.command === "take-over-space") {
        if (!this.agentControl) throw new Error("Agent control is unavailable");
        this.agentControl.revokeSpace(spaceId);
        await this.manager.setOwnership(spaceId, "user", "active");
        return;
      }
      if (message.command === "terminate-space") {
        if (!this.agentControl) throw new Error("Agent control is unavailable");
        this.agentControl.revokeSpace(spaceId);
        await this.manager.setLifecycle(spaceId, "completed");
        return;
      }
    }
    throw new Error(`unknown presentation command: ${command}`);
  }
}
