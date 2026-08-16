import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { DownloadRegistry } from "./download-registry.js";
import { TaskSpaceManager } from "./manager.js";
import { SpaceLeaseRegistry } from "./space-lease.js";
import {
  SpaceEventJournal,
  type SpaceEventCategory,
} from "./space-event-journal.js";

type SessionRoute = {
  connectionId: string;
  spaceId: number;
  targetId: string;
  ownerTargetId: string;
  generation: number;
  upstreamSessionId?: string;
};

type SendEvent = (payload: string) => void;

export class CdpBroker {
  private readonly sessions = new Map<string, SessionRoute>();
  private readonly senders = new Map<string, SendEvent>();
  private readonly boundContents = new Set<number>();
  private readonly agentScreencasts = new Map<string, string>();
  private readonly focusEmulatedTargets = new Set<string>();
  private readonly focusEmulationTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly agentAwakeTargets = new Set<string>();
  private readonly backgroundThrottlingTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly downloads: DownloadRegistry;

  constructor(
    private readonly manager: TaskSpaceManager,
    private readonly leases: SpaceLeaseRegistry,
    private readonly journal?: SpaceEventJournal,
  ) {
    this.downloads = new DownloadRegistry({
      locateSource: (webContentsId) => {
        const located = this.manager.findSpaceByWebContentsId(webContentsId);
        return located
          ? { spaceId: located.space.id, targetId: located.tab.targetId }
          : undefined;
      },
      emit: (event) => this.emitDownloadEvent(event),
    });
    this.manager.onControlChanged?.((spaceId) => {
      const space = this.manager.getSpace(spaceId);
      if (space?.ownership === "agent" && space.lifecycle === "active") return;
      for (const tab of space?.tabs ?? []) {
        const view = this.manager.getView(tab.targetId);
        if (view) {
          void this.setFocusEmulation(tab.targetId, view.webContents, false);
          this.restoreBackgroundThrottling(tab.targetId, view.webContents);
        }
      }
    });
  }

  registerConnection(connectionId: string, sender: SendEvent) {
    this.senders.set(connectionId, sender);
  }

  removeConnection(connectionId: string) {
    this.senders.delete(connectionId);
    this.downloads.removeConnection(connectionId);
    for (const [sessionId, route] of this.sessions) {
      if (route.connectionId !== connectionId) continue;
      void this.releaseSession(sessionId, route);
    }
  }

  releaseConnectionSpace(connectionId: string, spaceId: number) {
    this.downloads.releaseConnectionSpace(connectionId, spaceId);
    for (const [sessionId, route] of this.sessions) {
      if (route.connectionId !== connectionId || route.spaceId !== spaceId) continue;
      void this.releaseSession(sessionId, route);
    }
  }

  async send(
    connectionId: string,
    spaceId: number,
    generation: number,
    payload: string,
  ) {
    this.leases.assert(spaceId, connectionId, generation);
    const message = JSON.parse(payload);
    const { id, method, params = {}, sessionId } = message;
    const startedAt = Date.now();
    this.recordCdpCommand(
      connectionId,
      spaceId,
      sessionId,
      method,
      "started",
      params,
    );
    try {
      const result = await this.dispatch(
        connectionId,
        spaceId,
        generation,
        method,
        params,
        sessionId,
      );
      this.recordCdpCommand(
        connectionId,
        spaceId,
        sessionId,
        method,
        "finished",
        { status: "success", durationMs: Date.now() - startedAt },
      );
      this.emit(connectionId, JSON.stringify({ id, result }));
    } catch (error: any) {
      this.recordCdpCommand(
        connectionId,
        spaceId,
        sessionId,
        method,
        "finished",
        {
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: error?.message || String(error),
        },
      );
      this.emit(
        connectionId,
        JSON.stringify({
          id,
          error: { message: error?.message || String(error) },
        }),
      );
    }
  }

  private async dispatch(
    connectionId: string,
    spaceId: number,
    generation: number,
    method: string,
    params: any,
    sessionId?: string,
  ) {
    if (method === "Target.getTargets") {
      const space = this.manager.getSpaceOrThrow(spaceId);
      const active = await this.manager.activeView(spaceId);
      this.bindDebugger(space.activeTabId, active.webContents);
      await this.manager.ensureBackgroundSurface(spaceId, space.activeTabId);
      const childTargets = await scopedChildTargets(active.webContents);
      return {
        targetInfos: [
          ...space.tabs.map((tab) => ({
            targetId: tab.targetId,
            type: "page",
            title: tab.title,
            url: tab.url,
            attached: [...this.sessions.values()].some(
              (route) => route.targetId === tab.targetId,
            ),
          })),
          ...childTargets.map((target) => ({
            ...target,
            attached: [...this.sessions.values()].some(
              (route) => route.targetId === target.targetId,
            ),
          })),
        ],
      };
    }
    if (method === "Target.attachToTarget") {
      const targetId = String(params.targetId || "");
      const space = this.manager.getSpaceOrThrow(spaceId);
      const tab = space.tabs.find((candidate) => candidate.targetId === targetId);
      const ownerTab = tab ?? this.manager.getActiveTab(spaceId);
      const view = await this.manager.ensureTabRuntime(spaceId, ownerTab.targetId);
      this.bindDebugger(ownerTab.targetId, view.webContents);
      await this.manager.ensureBackgroundSurface(spaceId, ownerTab.targetId);
      let upstreamSessionId: string | undefined;
      if (!tab) {
        const childTargets = await scopedChildTargets(view.webContents);
        if (!childTargets.some((target) => target.targetId === targetId)) {
          throw new Error(`target not found: ${targetId}`);
        }
        const attached = await view.webContents.debugger.sendCommand(
          "Target.attachToTarget",
          { targetId, flatten: true },
        );
        upstreamSessionId = attached.sessionId;
      }
      const synthetic = `x-browser-${randomUUID()}`;
      this.sessions.set(synthetic, {
        connectionId,
        spaceId,
        targetId,
        ownerTargetId: ownerTab.targetId,
        generation,
        upstreamSessionId,
      });
      return { sessionId: synthetic };
    }
    if (method === "Target.detachFromTarget") {
      const syntheticSessionId = String(params.sessionId || "");
      const route = this.sessions.get(syntheticSessionId);
      if (!route || route.connectionId !== connectionId) {
        throw new Error("Session with given id not found");
      }
      await this.releaseSession(syntheticSessionId, route);
      return {};
    }
    if (method === "Target.activateTarget") {
      await this.manager.activateTab(spaceId, params.targetId);
      return {};
    }
    if (method === "Target.closeTarget") {
      await this.manager.closeTab(spaceId, params.targetId);
      return { success: true };
    }
    if (method === "Browser.getVersion") {
      const view = await this.manager.activeView(spaceId);
      return view.webContents.debugger.sendCommand("Browser.getVersion");
    }
    if (method === "Browser.setDownloadBehavior") {
      const tab = this.manager.getActiveTab(spaceId);
      const view = await this.manager.ensureTabRuntime(spaceId, tab.targetId);
      await this.downloads.configure({
        connectionId,
        spaceId,
        targetId: tab.targetId,
        scope: "browser",
        behavior: params.behavior,
        downloadPath: params.downloadPath,
        session: view.webContents.session,
      });
      return {};
    }
    if (!sessionId) throw new Error(`missing sessionId for ${method}`);
    const route = this.sessions.get(sessionId);
    if (!route || route.connectionId !== connectionId) {
      throw new Error("Session with given id not found");
    }
    this.leases.assert(route.spaceId, connectionId, route.generation);
    const view = await this.manager.ensureTabRuntime(
      route.spaceId,
      route.ownerTargetId,
    );
    this.bindDebugger(route.ownerTargetId, view.webContents);
    const controlsPausedRequest = method.startsWith("Fetch.");
    if (!controlsPausedRequest) {
      await this.manager.ensureBackgroundSurface(
        route.spaceId,
        route.ownerTargetId,
      );
    }
    const isInput = method.startsWith("Input.");
    if (method === "Page.setDownloadBehavior") {
      await this.downloads.configure({
        connectionId,
        spaceId: route.spaceId,
        targetId: route.ownerTargetId,
        scope: "page",
        behavior: params.behavior,
        downloadPath: params.downloadPath,
        session: view.webContents.session,
      });
      return {};
    }
    const rootScreencast = route.upstreamSessionId === undefined;
    const startsScreencast = rootScreencast && method === "Page.startScreencast";
    const stopsScreencast = rootScreencast && method === "Page.stopScreencast";
    const alreadyRecording = this.agentScreencasts.has(sessionId);
    if (startsScreencast && !alreadyRecording) {
      await this.manager.suspendOverviewScreencast(route.ownerTargetId);
    }
    try {
      // A transparent App-level WebContentsView can geometrically occlude the
      // page beneath it. Chromium then reports a hidden 0x0 viewport even
      // though the last page frame remains visible to the human. Wake the page
      // only for the bounded Agent command burst; this keeps screenshots,
      // evaluate and trusted input independent from the human-control overlay
      // without leaving background pages at foreground GPU cadence.
      if (!controlsPausedRequest) {
        await this.beginAgentActivity(route.ownerTargetId, view.webContents);
      }
      // Input preparation can itself race navigation or renderer teardown.
      // Keep it inside the cleanup boundary so temporary focus emulation is
      // always released. The App-level overlay is a separate native View and
      // never participates in the page CDP input path.
      if (isInput) {
        await this.beginAgentInput(route.ownerTargetId, view.webContents);
      }
      const result = await view.webContents.debugger.sendCommand(
        method,
        params,
        route.upstreamSessionId,
      );
      if (
        isInput ||
        method === "Runtime.evaluate" ||
        method.startsWith("DOM.") ||
        method.startsWith("Page.navigate")
      ) {
        this.manager.noteOverviewActivity(route.ownerTargetId);
      }
      if (startsScreencast) {
        this.agentScreencasts.set(sessionId, route.ownerTargetId);
      } else if (stopsScreencast) {
        this.releaseAgentScreencast(sessionId);
      }
      return result;
    } catch (error) {
      if (startsScreencast && !alreadyRecording) {
        this.resumeOverviewIfAgentIdle(route.ownerTargetId);
      }
      throw error;
    } finally {
      if (isInput) this.endAgentInput(route.ownerTargetId, view.webContents);
      if (!controlsPausedRequest) {
        this.endAgentActivity(route.ownerTargetId, view.webContents);
      }
    }
  }

  private bindDebugger(targetId: string, contents: WebContents) {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    if (this.boundContents.has(contents.id)) return;
    this.boundContents.add(contents.id);
    contents.debugger.on(
      "message",
      (_event, method, params, upstreamSessionId?: string) => {
        this.recordDebuggerEvent(targetId, method, params);
        const eventSessionId = upstreamSessionId || undefined;
        for (const [sessionId, route] of this.sessions) {
          if (route.ownerTargetId !== targetId) continue;
          if ((route.upstreamSessionId || undefined) !== eventSessionId) continue;
          this.emit(
            route.connectionId,
            JSON.stringify({ method, params, sessionId }),
          );
        }
      },
    );
    contents.once("destroyed", () => {
      const space = this.manager.findSpaceByTargetId(targetId);
      if (space) {
        this.journal?.append({
          spaceId: space.id,
          tabId: targetId,
          category: "lifecycle",
          type: "renderer.destroyed",
        });
      }
      this.boundContents.delete(contents.id);
      this.focusEmulatedTargets.delete(targetId);
      const focusTimer = this.focusEmulationTimers.get(targetId);
      if (focusTimer) clearTimeout(focusTimer);
      this.focusEmulationTimers.delete(targetId);
      const throttleTimer = this.backgroundThrottlingTimers.get(targetId);
      if (throttleTimer) clearTimeout(throttleTimer);
      this.backgroundThrottlingTimers.delete(targetId);
      this.agentAwakeTargets.delete(targetId);
      for (const [sessionId, route] of this.sessions) {
        if (route.ownerTargetId !== targetId) continue;
        void this.releaseSession(sessionId, route, false);
      }
    });
  }

  private async releaseSession(
    sessionId: string,
    route: SessionRoute,
    detachUpstream = true,
  ) {
    if (!this.sessions.delete(sessionId)) return;
    this.releaseAgentScreencast(sessionId);
    if (!detachUpstream || !route.upstreamSessionId) return;
    const view = this.manager.getView?.(route.ownerTargetId);
    const contents = view?.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      !contents.debugger.isAttached()
    ) {
      return;
    }
    await contents.debugger
      .sendCommand("Target.detachFromTarget", {
        sessionId: route.upstreamSessionId,
      })
      .catch(() => undefined);
  }

  private releaseAgentScreencast(sessionId: string) {
    const targetId = this.agentScreencasts.get(sessionId);
    if (!targetId) return;
    this.agentScreencasts.delete(sessionId);
    this.resumeOverviewIfAgentIdle(targetId);
    const view = this.manager.getView?.(targetId);
    if (view) this.endAgentActivity(targetId, view.webContents);
  }

  private resumeOverviewIfAgentIdle(targetId: string) {
    if ([...this.agentScreencasts.values()].some((value) => value === targetId)) {
      return;
    }
    this.manager.resumeOverviewScreencast(targetId);
  }

  private emit(connectionId: string, payload: string) {
    this.senders.get(connectionId)?.(payload);
  }

  private async beginAgentInput(targetId: string, contents: WebContents) {
    const focusTimer = this.focusEmulationTimers.get(targetId);
    if (focusTimer) clearTimeout(focusTimer);
    this.focusEmulationTimers.delete(targetId);
    await this.setFocusEmulation(targetId, contents, true);
  }

  private async beginAgentActivity(targetId: string, contents: WebContents) {
    const pendingRestore = this.backgroundThrottlingTimers.get(targetId);
    if (pendingRestore) clearTimeout(pendingRestore);
    this.backgroundThrottlingTimers.delete(targetId);
    if (this.agentAwakeTargets.has(targetId) || contents.isDestroyed()) return;
    if (typeof contents.setBackgroundThrottling !== "function") return;
    this.agentAwakeTargets.add(targetId);
    this.setAgentForegroundCadence(targetId, contents, true);
    if (typeof contents.executeJavaScript !== "function") return;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const viewport = await contents
        .executeJavaScript(
          `({ width: window.innerWidth, height: window.innerHeight })`,
          false,
        )
        .catch(() => null);
      if (Number(viewport?.width) > 1 && Number(viewport?.height) > 1) return;
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
  }

  private endAgentActivity(targetId: string, contents: WebContents) {
    if (!this.agentAwakeTargets.has(targetId)) return;
    if ([...this.agentScreencasts.values()].includes(targetId)) return;
    const previous = this.backgroundThrottlingTimers.get(targetId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.backgroundThrottlingTimers.delete(targetId);
      this.restoreBackgroundThrottling(targetId, contents);
    }, 750);
    this.backgroundThrottlingTimers.set(targetId, timer);
  }

  private restoreBackgroundThrottling(
    targetId: string,
    contents: WebContents,
  ) {
    const timer = this.backgroundThrottlingTimers.get(targetId);
    if (timer) clearTimeout(timer);
    this.backgroundThrottlingTimers.delete(targetId);
    if (!this.agentAwakeTargets.delete(targetId) || contents.isDestroyed()) return;
    this.setAgentForegroundCadence(targetId, contents, false);
  }

  private setAgentForegroundCadence(
    targetId: string,
    contents: WebContents,
    active: boolean,
  ) {
    const manager = this.manager as TaskSpaceManager & {
      setPageForegroundCadence?: (
        targetId: string,
        reason: string,
        active: boolean,
      ) => void;
    };
    if (typeof manager.setPageForegroundCadence === "function") {
      manager.setPageForegroundCadence(targetId, "agent-command", active);
      return;
    }
    contents.setBackgroundThrottling?.(!active);
  }

  private endAgentInput(targetId: string, contents: WebContents) {
    const previousFocusTimer = this.focusEmulationTimers.get(targetId);
    if (previousFocusTimer) clearTimeout(previousFocusTimer);
    const focusTimer = setTimeout(() => {
      this.focusEmulationTimers.delete(targetId);
      void this.setFocusEmulation(targetId, contents, false);
    }, 750);
    this.focusEmulationTimers.set(targetId, focusTimer);
  }

  private async setFocusEmulation(
    targetId: string,
    contents: WebContents,
    enabled: boolean,
  ) {
    if (contents.isDestroyed()) return;
    if (!enabled) {
      const timer = this.focusEmulationTimers.get(targetId);
      if (timer) clearTimeout(timer);
      this.focusEmulationTimers.delete(targetId);
    }
    this.bindDebugger(targetId, contents);
    try {
      await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
        enabled,
      });
      if (enabled) this.focusEmulatedTargets.add(targetId);
      else this.focusEmulatedTargets.delete(targetId);
    } catch {
      if (!enabled) this.focusEmulatedTargets.delete(targetId);
      // Focus emulation is a compatibility optimization. Trusted input still
      // uses the real target debugger when Chromium rejects the command.
    }
  }

  private emitDownloadEvent(event: {
    connectionId: string;
    spaceId: number;
    targetId: string;
    method: string;
    params: Record<string, unknown>;
  }) {
    this.journal?.append({
      spaceId: event.spaceId,
      connectionId: event.connectionId,
      tabId: event.targetId,
      category: "download",
      type: event.method,
      data: event.params,
    });
    const matching = [...this.sessions.entries()].filter(
      ([, route]) =>
        route.connectionId === event.connectionId &&
        route.spaceId === event.spaceId &&
        route.ownerTargetId === event.targetId,
    );
    const rootRoutes = matching.filter(([, route]) => !route.upstreamSessionId);
    const recipients = rootRoutes.length > 0 ? rootRoutes : matching.slice(-1);
    for (const [sessionId] of recipients) {
      this.emit(
        event.connectionId,
        JSON.stringify({
          method: event.method,
          params: event.params,
          sessionId,
        }),
      );
    }
  }

  private recordCdpCommand(
    connectionId: string,
    spaceId: number,
    sessionId: string | undefined,
    method: string,
    phase: "started" | "finished",
    params: Record<string, unknown>,
  ) {
    if (!this.journal || !traceableCdpCommand(method)) return;
    const route = sessionId ? this.sessions.get(sessionId) : undefined;
    const tabId = route?.ownerTargetId ?? this.manager.getSpace(spaceId)?.activeTabId;
    this.journal.append({
      spaceId,
      connectionId,
      tabId,
      category: "trace",
      type: `cdp.command.${phase}`,
      data: {
        method,
        ...summarizeCdpParams(method, params),
      },
    });
  }

  private recordDebuggerEvent(
    targetId: string,
    method: string,
    params: Record<string, unknown>,
  ) {
    if (!this.journal) return;
    const descriptor = diagnosticEvent(method, params);
    if (!descriptor) return;
    const space = this.manager.findSpaceByTargetId(targetId);
    if (!space) return;
    this.journal.append({
      spaceId: space.id,
      tabId: targetId,
      category: descriptor.category,
      type: method,
      data: descriptor.data,
    });
  }
}

function traceableCdpCommand(method: string) {
  return (
    method.startsWith("Input.") ||
    method === "Page.navigate" ||
    method === "Page.reload" ||
    method === "Page.handleJavaScriptDialog" ||
    method === "Page.captureScreenshot" ||
    method === "Runtime.evaluate" ||
    method.startsWith("DOM.")
  );
}

function summarizeCdpParams(
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (method === "Runtime.evaluate") {
    return { expressionLength: String(params.expression ?? "").length };
  }
  if (method === "Input.insertText") return { text: "[redacted]" };
  if (method.startsWith("Input.")) {
    return {
      type: params.type,
      key: params.key,
      code: params.code,
      x: params.x,
      y: params.y,
      button: params.button,
      clickCount: params.clickCount,
      deltaX: params.deltaX,
      deltaY: params.deltaY,
    };
  }
  if (method === "Page.navigate") return { url: params.url };
  if (method === "Page.handleJavaScriptDialog") {
    return { accept: params.accept === true, promptText: "[redacted]" };
  }
  return {};
}

function diagnosticEvent(
  method: string,
  params: Record<string, any>,
): { category: SpaceEventCategory; data?: Record<string, unknown> } | undefined {
  if (method === "Page.frameNavigated") {
    if (params.frame?.parentId) return undefined;
    return {
      category: "navigation",
      data: { url: params.frame?.url, frameId: params.frame?.id },
    };
  }
  if (method === "Page.frameStoppedLoading") {
    return { category: "navigation", data: { frameId: params.frameId } };
  }
  if (method.startsWith("Page.javascriptDialog")) {
    return {
      category: "dialog",
      data: {
        type: params.type,
        message: params.message,
        result: params.result,
        userInput: "[redacted]",
      },
    };
  }
  if (method === "Network.loadingFailed") {
    return {
      category: "network",
      data: {
        requestId: params.requestId,
        errorText: params.errorText,
        canceled: params.canceled,
        blockedReason: params.blockedReason,
      },
    };
  }
  if (method === "Network.responseReceived" && Number(params.response?.status) >= 400) {
    return {
      category: "network",
      data: {
        requestId: params.requestId,
        url: params.response?.url,
        status: params.response?.status,
        statusText: params.response?.statusText,
        mimeType: params.response?.mimeType,
      },
    };
  }
  if (method === "Runtime.exceptionThrown") {
    return {
      category: "console",
      data: {
        text: params.exceptionDetails?.text,
        description: params.exceptionDetails?.exception?.description,
        lineNumber: params.exceptionDetails?.lineNumber,
        columnNumber: params.exceptionDetails?.columnNumber,
        url: params.exceptionDetails?.url,
      },
    };
  }
  if (method === "Runtime.consoleAPICalled" && params.type === "error") {
    return {
      category: "console",
      data: {
        level: params.type,
        text: (params.args ?? []).map((item: any) => item.value ?? item.description).join(" "),
      },
    };
  }
  if (method === "Inspector.targetCrashed") {
    return { category: "lifecycle", data: { status: params.status } };
  }
  return undefined;
}

type TargetInfo = {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
};

export function collectFrameIds(frameTree: any) {
  const ids = new Set<string>();
  const visit = (node: any) => {
    if (node?.frame?.id) ids.add(String(node.frame.id));
    for (const child of node?.childFrames ?? []) visit(child);
  };
  visit(frameTree);
  return ids;
}

export function collectDomFrameIds(root: any) {
  const ids = new Set<string>();
  const visit = (node: any) => {
    if (node?.frameId) ids.add(String(node.frameId));
    for (const child of node?.children ?? []) visit(child);
    for (const shadowRoot of node?.shadowRoots ?? []) visit(shadowRoot);
    if (node?.contentDocument) visit(node.contentDocument);
  };
  visit(root);
  return ids;
}

export function filterScopedChildTargets(
  frameIds: Set<string>,
  targets: TargetInfo[],
) {
  return targets.filter(
    (target) => target.type === "iframe" && frameIds.has(target.targetId),
  );
}

export async function scopedChildTargets(contents: WebContents) {
  try {
    const [frames, document, targets] = await Promise.all([
      contents.debugger.sendCommand("Page.getFrameTree"),
      contents.debugger.sendCommand("DOM.getDocument", {
        depth: -1,
        pierce: true,
      }),
      contents.debugger.sendCommand("Target.getTargets"),
    ]);
    if (
      process.env.UFO_BROWSER_DEBUG_TARGETS === "1" ||
      process.env.X_BROWSER_DEBUG_TARGETS === "1"
    ) {
      console.error(
        "X_BROWSER_TARGET_DEBUG",
        JSON.stringify({ frames, document, targets }),
      );
    }
    const frameIds = collectFrameIds(frames.frameTree);
    for (const frameId of collectDomFrameIds(document.root)) {
      frameIds.add(frameId);
    }
    return filterScopedChildTargets(
      frameIds,
      targets.targetInfos ?? [],
    );
  } catch {
    return [];
  }
}
