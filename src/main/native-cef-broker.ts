import { randomUUID } from "node:crypto";
import type { AgentCdpBrokerHost } from "./agent-host-types.js";
import type { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";

type NativeSession = {
  connectionId: string;
  spaceId: number;
  targetId: string;
  generation: number;
  connection: any;
  unsubscribe: () => void;
};

/** CEF target adapter for the existing multiplexed UFO Agent protocol. */
export class NativeCefBroker implements AgentCdpBrokerHost {
  private readonly sessions = new Map<string, NativeSession>();
  private readonly senders = new Map<string, (payload: string) => void>();

  constructor(private readonly manager: NativeCefTaskSpaceManager) {}

  registerConnection(connectionId: string, sender: (payload: string) => void) {
    this.senders.set(connectionId, sender);
  }

  removeConnection(connectionId: string) {
    this.senders.delete(connectionId);
    for (const [sessionId, session] of this.sessions) {
      if (session.connectionId !== connectionId) continue;
      session.unsubscribe();
      void session.connection.close();
      this.sessions.delete(sessionId);
    }
  }

  releaseConnectionSpace(connectionId: string, spaceId: number) {
    for (const [sessionId, session] of this.sessions) {
      if (session.connectionId !== connectionId || session.spaceId !== spaceId) continue;
      session.unsubscribe();
      void session.connection.close();
      this.sessions.delete(sessionId);
    }
  }

  async send(connectionId: string, spaceId: number, generation: number, payload: string) {
    const message = JSON.parse(payload);
    const result = await this.dispatch(connectionId, spaceId, generation, message.method, message.params || {}, message.sessionId);
    this.emit(connectionId, JSON.stringify({ id: message.id, result }));
  }

  private async dispatch(connectionId: string, spaceId: number, generation: number, method: string, params: any, sessionId?: string) {
    const runtime = await this.manager.ensureRuntime(spaceId);
    if (method === "Browser.getVersion") return runtime.version();
    if (method === "Target.getTargets") {
      const targets = await runtime.targets();
      return { targetInfos: targets.map((target) => ({ targetId: target.id, type: target.type, title: target.title, url: target.url, attached: false })) };
    }
    if (method === "Target.attachToTarget") {
      const targetId = String(params.targetId || "");
      const target = (await runtime.targets()).find((candidate) => candidate.id === targetId) ?? (await runtime.targets()).find((candidate) => candidate.type === "page");
      if (!target?.webSocketDebuggerUrl) throw new Error(`target not found: ${targetId}`);
      const connection = await runtime.connect(target.id);
      const synthetic = `ufo-cef-${randomUUID()}`;
      const unsubscribe = connection.onEvent((event: any) => {
        this.emit(connectionId, JSON.stringify({ method: event.method, params: event.params, sessionId: synthetic }));
      });
      this.sessions.set(synthetic, { connectionId, spaceId, targetId: target.id, generation, connection, unsubscribe });
      return { sessionId: synthetic };
    }
    if (!sessionId) throw new Error(`missing sessionId for ${method}`);
    const session = this.sessions.get(sessionId);
    if (!session || session.connectionId !== connectionId || session.spaceId !== spaceId) throw new Error("Session with given id not found");
    // Native target WebSockets are already scoped to the page. The synthetic
    // UFO session is used only for protocol compatibility and is not forwarded.
    const result = await session.connection.send(method, params);
    if (method === "Page.navigate" && result?.frameId) {
      const space = this.manager.getSpace(spaceId);
      const tab = space?.tabs.find((candidate: any) => candidate.targetId === session.targetId);
      if (tab && typeof params.url === "string") tab.url = params.url;
    }
    return result;
  }

  private emit(connectionId: string, payload: string) {
    this.senders.get(connectionId)?.(payload);
  }
}
