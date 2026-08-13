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
  upstreamSessionId?: string;
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
      const browser = await this.manager.ensureBrowserConnectionForAgent(spaceId, runtime);
      const result = await browser.send("Target.getTargets");
      return { targetInfos: result?.targetInfos ?? [] };
    }
    if (method === "Target.createTarget") {
      const tab = await this.manager.createTab(spaceId, String(params.url || "about:blank"));
      if (!tab) throw new Error("Native CEF did not create a tab record");
      return { targetId: tab.targetId };
    }
    if (method === "Target.activateTarget") {
      await this.manager.activateTab(spaceId, String(params.targetId || ""));
      return {};
    }
    if (method === "Target.closeTarget") {
      await this.manager.closeTab(spaceId, String(params.targetId || ""));
      return { success: true };
    }
    if (method === "Target.attachToTarget") {
      const targetId = String(params.targetId || "");
      const browser = await this.manager.ensureBrowserConnectionForAgent(spaceId, runtime);
      const targets = (await browser.send("Target.getTargets")).targetInfos ?? [];
      const target = targets.find((candidate: any) => candidate.targetId === targetId) ?? targets.find((candidate: any) => candidate.type === "page");
      if (!target) throw new Error(`target not found: ${targetId}`);
      const synthetic = `ufo-cef-${randomUUID()}`;
      if (target.type === "page") {
        const connection = await runtime.connect(target.targetId);
        await waitForConnectionUrl(connection, target.url);
        const unsubscribe = connection.onEvent((event: any) => {
          this.emit(connectionId, JSON.stringify({ method: event.method, params: event.params, sessionId: synthetic }));
        });
        this.sessions.set(synthetic, { connectionId, spaceId, targetId: target.targetId, generation, connection, unsubscribe });
        return { sessionId: synthetic };
      }
      const attached = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const upstreamSessionId = attached?.sessionId;
      if (!upstreamSessionId) throw new Error(`Native CEF did not attach target: ${target.targetId}`);
      const unsubscribe = browser.onEvent((event: any) => {
        if (event.sessionId !== upstreamSessionId) return;
        this.emit(connectionId, JSON.stringify({ method: event.method, params: event.params, sessionId: synthetic }));
      });
      this.sessions.set(synthetic, { connectionId, spaceId, targetId: target.targetId, generation, connection: browser, unsubscribe, upstreamSessionId });
      return { sessionId: synthetic };
    }
    if (!sessionId) throw new Error(`missing sessionId for ${method}`);
    const session = this.sessions.get(sessionId);
    if (!session || session.connectionId !== connectionId || session.spaceId !== spaceId) throw new Error("Session with given id not found");
    // Native target WebSockets are already scoped to the page. The synthetic
    // UFO session is used only for protocol compatibility and is not forwarded.
    const result = await session.connection.send(method, params, session.upstreamSessionId);
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

  // The manager keeps this method intentionally narrow: only the broker can
  // request the Browser-level transport used for target enumeration and OOPIF
  // sessions. It is not exposed as a general Agent RPC.
}

async function waitForConnectionUrl(connection: any, expectedUrl: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await connection.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    }).catch(() => undefined);
    const url = result?.result?.value;
    if (typeof url === "string" && url !== "about:blank" && (!expectedUrl || url === expectedUrl || url.startsWith(expectedUrl))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}
