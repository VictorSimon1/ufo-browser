import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { DownloadRegistry } from "./download-registry.js";
import { TaskSpaceManager } from "./manager.js";
import { SpaceLeaseRegistry } from "./space-lease.js";

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
  private readonly downloads: DownloadRegistry;

  constructor(
    private readonly manager: TaskSpaceManager,
    private readonly leases: SpaceLeaseRegistry,
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
      this.sessions.delete(sessionId);
      this.releaseAgentScreencast(sessionId);
    }
  }

  releaseConnectionSpace(connectionId: string, spaceId: number) {
    this.downloads.releaseConnectionSpace(connectionId, spaceId);
    for (const [sessionId, route] of this.sessions) {
      if (route.connectionId !== connectionId || route.spaceId !== spaceId) continue;
      this.sessions.delete(sessionId);
      this.releaseAgentScreencast(sessionId);
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
    try {
      const result = await this.dispatch(
        connectionId,
        spaceId,
        generation,
        method,
        params,
        sessionId,
      );
      this.emit(connectionId, JSON.stringify({ id, result }));
    } catch (error: any) {
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
    await this.manager.ensureBackgroundSurface(route.spaceId, route.ownerTargetId);
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
    }
  }

  private bindDebugger(targetId: string, contents: WebContents) {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    if (this.boundContents.has(contents.id)) return;
    this.boundContents.add(contents.id);
    contents.debugger.on(
      "message",
      (_event, method, params, upstreamSessionId?: string) => {
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
      this.boundContents.delete(contents.id);
      this.focusEmulatedTargets.delete(targetId);
      const focusTimer = this.focusEmulationTimers.get(targetId);
      if (focusTimer) clearTimeout(focusTimer);
      this.focusEmulationTimers.delete(targetId);
      for (const [sessionId, route] of this.sessions) {
        if (route.ownerTargetId !== targetId) continue;
        this.sessions.delete(sessionId);
        this.releaseAgentScreencast(sessionId);
      }
    });
  }

  private releaseAgentScreencast(sessionId: string) {
    const targetId = this.agentScreencasts.get(sessionId);
    if (!targetId) return;
    this.agentScreencasts.delete(sessionId);
    this.resumeOverviewIfAgentIdle(targetId);
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
