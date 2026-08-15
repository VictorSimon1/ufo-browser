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
  private readonly connectionSpaces = new Map<string, Set<number>>();
  private readonly browserEventSubscriptions = new Map<number, { unsubscribe: () => void }>();

  constructor(private readonly manager: NativeCefTaskSpaceManager) {}

  registerConnection(connectionId: string, sender: (payload: string) => void) {
    this.senders.set(connectionId, sender);
  }

  removeConnection(connectionId: string) {
    this.senders.delete(connectionId);
    const spaces = this.connectionSpaces.get(connectionId) ?? new Set<number>();
    this.connectionSpaces.delete(connectionId);
    for (const spaceId of spaces) this.releaseUnusedBrowserEvents(spaceId);
    for (const [sessionId, session] of this.sessions) {
      if (session.connectionId !== connectionId) continue;
      session.unsubscribe();
      void session.connection.close();
      this.sessions.delete(sessionId);
    }
  }

  releaseConnectionSpace(connectionId: string, spaceId: number) {
    this.connectionSpaces.get(connectionId)?.delete(spaceId);
    this.releaseUnusedBrowserEvents(spaceId);
    for (const [sessionId, session] of this.sessions) {
      if (session.connectionId !== connectionId || session.spaceId !== spaceId) continue;
      session.unsubscribe();
      void session.connection.close();
      this.sessions.delete(sessionId);
    }
  }

  async send(connectionId: string, spaceId: number, generation: number, payload: string) {
    let spaces = this.connectionSpaces.get(connectionId);
    if (!spaces) this.connectionSpaces.set(connectionId, spaces = new Set());
    spaces.add(spaceId);
    const message = JSON.parse(payload);
    const result = await this.dispatch(connectionId, spaceId, generation, message.method, message.params || {}, message.sessionId);
    this.emit(connectionId, JSON.stringify({ id: message.id, result }));
  }

  private async dispatch(connectionId: string, spaceId: number, generation: number, method: string, params: any, sessionId?: string) {
    const runtime = await this.manager.ensureRuntime(spaceId);
    if (method === "Browser.getVersion") return runtime.version();
    if (method === "Browser.setDownloadBehavior") {
      const browser = await this.manager.ensureBrowserConnectionForAgent(spaceId, runtime);
      this.ensureBrowserEvents(spaceId, browser);
      return browser.send(method, params);
    }
    if (method === "Target.getTargets") {
      const targetInfos = (await runtime.targets()).map((target) => ({
        targetId: target.id,
        type: target.type,
        title: target.title,
        url: target.url,
        parentId: target.parentId,
        parentFrameId: target.parentFrameId,
        openerId: target.openerId,
      }));
      // Reconcile asynchronously. Target enumeration is a control-plane
      // query and must return immediately even while the durable Space state
      // store is flushing a popup/title update; serializing the save here can
      // otherwise make listTabs appear to hang after window.open().
      // Keep the in-memory tab projection current before returning the RPC.
      // The reconcile itself never waits on durable state I/O; this makes a
      // popup visible to listTabs immediately while save() remains queued in
      // the background. Previously listTabs could observe a stale Space after
      // window.open() because every refresh was fire-and-forget.
      await this.manager.refreshTabsFromTargetInfos(spaceId, targetInfos);
      return { targetInfos };
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
      const targets = await runtime.targets();
      const target = targets.find((candidate) => candidate.id === targetId) ?? targets.find((candidate) => candidate.type === "page");
      if (!target) throw new Error(`target not found: ${targetId}`);
      const synthetic = `ufo-cef-${randomUUID()}`;
      if (target.type === "page") {
        const connection = await runtime.connect(target.id);
        // The loopback transport is already connected to the exact page
        // WebSocket selected from /json/list. Re-probing location.href here
        // can wait behind Chrome Runtime's unrelated top-chrome renderer and
        // turn a successful attach into a 15-second timeout. The private
        // browser-level bridge still needs the explicit readiness probe.
        if (runtime.usesPrivateBridge()) {
          await waitForConnectionUrl(connection, target.url);
        }
        const unsubscribe = connection.onEvent((event: any) => {
          this.emit(connectionId, JSON.stringify({ method: event.method, params: event.params, sessionId: synthetic }));
        });
        this.sessions.set(synthetic, { connectionId, spaceId, targetId: target.id, generation, connection, unsubscribe });
        return { sessionId: synthetic };
      }
      const attached = await browser.send("Target.attachToTarget", { targetId: target.id, flatten: true });
      const upstreamSessionId = attached?.sessionId;
      if (!upstreamSessionId) throw new Error(`Native CEF did not attach target: ${target.id}`);
      const unsubscribe = browser.onEvent((event: any) => {
        if (event.sessionId !== upstreamSessionId) return;
        this.emit(connectionId, JSON.stringify({ method: event.method, params: event.params, sessionId: synthetic }));
      });
      this.sessions.set(synthetic, { connectionId, spaceId, targetId: target.id, generation, connection: browser, unsubscribe, upstreamSessionId });
      return { sessionId: synthetic };
    }
    if (method === "Target.setDiscoverTargets" || method === "Target.setAutoAttach") {
      const browser = await this.manager.ensureBrowserConnectionForAgent(spaceId, runtime);
      return browser.send(method, params);
    }
    if (method === "Page.captureScreenshot" && !runtime.usesPrivateBridge()) {
      const format = params?.format === "jpeg" ? "jpeg" : "png";
      const quality = Number.isFinite(Number(params?.quality))
        ? Number(params.quality)
        : 80;
      return {
        data: await runtime.captureSharedSpaceScreenshot(
          spaceId,
          format,
          quality,
        ),
      };
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

  private ensureBrowserEvents(spaceId: number, browser: any) {
    if (this.browserEventSubscriptions.has(spaceId)) return;
    const unsubscribe = browser.onEvent((event: any) => {
      if (event?.method === "Page.downloadWillBegin" || event?.method === "Page.downloadProgress") {
        this.emitToSpace(spaceId, event);
      } else if (event?.method === "Browser.downloadWillBegin") {
        this.emitToSpace(spaceId, {
          method: "Page.downloadWillBegin",
          params: event.params,
        });
      } else if (event?.method === "Browser.downloadProgress") {
        this.emitToSpace(spaceId, {
          method: "Page.downloadProgress",
          params: event.params,
        });
      }
    });
    this.browserEventSubscriptions.set(spaceId, { unsubscribe });
  }

  private emitToSpace(spaceId: number, event: any) {
    for (const [connectionId, spaces] of this.connectionSpaces) {
      if (!spaces.has(spaceId)) continue;
      const matching = [...this.sessions.entries()].filter(
        ([, session]) => session.connectionId === connectionId && session.spaceId === spaceId,
      );
      const rootSessions = matching.filter(([, session]) => !session.upstreamSessionId);
      const recipients = rootSessions.length > 0 ? rootSessions : matching.slice(-1);
      if (recipients.length === 0) {
        this.emit(connectionId, JSON.stringify(event));
        continue;
      }
      for (const [sessionId] of recipients) {
        this.emit(connectionId, JSON.stringify({ ...event, sessionId }));
      }
    }
  }

  private releaseUnusedBrowserEvents(spaceId: number) {
    if ([...this.connectionSpaces.values()].some((spaces) => spaces.has(spaceId))) return;
    this.browserEventSubscriptions.get(spaceId)?.unsubscribe();
    this.browserEventSubscriptions.delete(spaceId);
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
