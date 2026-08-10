import type { BaseWindow, WebContentsView } from "electron";
import { calculateShellLayout } from "./shell-page-bounds.js";
import type { Presentation, Rect } from "./types.js";
import { TaskSpaceManager } from "./manager.js";
import {
  NativeSpaceTransition,
  type NativeSpaceTransitionRun,
} from "./native-space-transition.js";
import { NativeBrowserChrome } from "./native-browser-chrome.js";

type ShellViews = {
  chat: WebContentsView;
  overview: WebContentsView;
  browser: WebContentsView;
  overlay: WebContentsView;
};

type SpaceTransitionRequest = {
  source: Rect;
  token?: string;
  durationMs?: number;
  nativeRun?: NativeSpaceTransitionRun;
};

type PresentationRequestOptions = {
  parkPrevious?: boolean;
};

export class PresentationCoordinator {
  private presentation: Presentation = { kind: "overview" };
  private generation = 0;
  private commitQueue = Promise.resolve();
  private attachedPage: WebContentsView | null = null;
  private overlaySpaceId: number | null = null;
  private activeTransitionToken = "";
  private readonly expectedTransitionTokens = new Set<string>();
  private readonly overviewTargets = new Map<number, Rect>();
  private snapshotRefreshTimer?: ReturnType<typeof setTimeout>;
  private snapshotRefreshGeneration = 0;

  constructor(
    private readonly window: BaseWindow,
    private readonly views: ShellViews,
    private readonly manager: TaskSpaceManager,
    private readonly nativeTransition?: NativeSpaceTransition,
    private readonly nativeChrome?: NativeBrowserChrome,
  ) {
    this.window.on("resize", () => {
      this.layout();
      const current = this.presentation;
      if (current.kind === "space") {
        this.scheduleSnapshotRefresh(current.spaceId, 220);
      }
    });
    this.window.on("minimize", () => this.manager.setOverviewPreviewActive(false));
    this.window.on("hide", () => this.manager.setOverviewPreviewActive(false));
    this.window.on("restore", () => {
      this.syncWindowState();
    });
    this.window.on("show", () => this.syncWindowState());
    // Agent ownership/state broadcasts can update the overlay while another
    // macOS application owns the foreground. Never make a child WebContents
    // first responder from that background path. When the user explicitly
    // returns to UFO-Browser, the native window focus event is the safe point
    // to restore the overlay's input interception.
    this.window.on("focus", () => this.syncControlOverlay());
  }

  current() {
    return this.presentation;
  }

  syncWindowState() {
    this.layout();
    this.nativeChrome?.setVisible(this.presentation.kind === "space");
    this.syncControlOverlay();
    this.syncPreviewActivity();
    // The shell can receive its initial Presentation while the native window
    // is still hidden. Re-publish after show/restore so Overview schedules
    // visibility work against a live compositor instead of waiting for a
    // throttled hidden requestAnimationFrame to eventually run.
    this.publishState();
  }

  showOverview(options?: PresentationRequestOptions) {
    this.cancelSnapshotRefresh();
    return this.request({ kind: "overview" }, undefined, options);
  }

  scheduleSnapshotRefresh(spaceId: number, delayMs = 160) {
    if (!this.nativeTransition) return;
    const current = this.presentation;
    if (current.kind !== "space" || current.spaceId !== spaceId) return;
    const generation = ++this.snapshotRefreshGeneration;
    if (this.snapshotRefreshTimer) clearTimeout(this.snapshotRefreshTimer);
    this.snapshotRefreshTimer = setTimeout(() => {
      if (generation !== this.snapshotRefreshGeneration) return;
      this.snapshotRefreshTimer = undefined;
      void this.captureVisibleSnapshot(spaceId).catch(() => undefined);
    }, Math.max(0, delayMs));
  }

  setOverviewTargets(targets: Array<{ id: number; rect: Rect }>) {
    const next = new Map<number, Rect>();
    for (const target of targets) {
      if (!Number.isSafeInteger(target.id) || target.id <= 0) continue;
      if (target.rect.width < 32 || target.rect.height < 32) continue;
      next.set(target.id, { ...target.rect });
    }
    this.overviewTargets.clear();
    for (const [spaceId, rect] of next) this.overviewTargets.set(spaceId, rect);
  }

  showSpace(spaceId: number, transition?: SpaceTransitionRequest) {
    const token = transition?.token;
    if (token) this.expectedTransitionTokens.add(token);
    const preparedTransition = transition ? { ...transition } : undefined;
    if (token && preparedTransition && this.nativeTransition) {
      const [width, height] = this.window.getContentSize();
      const layout = calculateShellLayout(width, height);
      const source = this.clampTransitionSource(
        preparedTransition.source,
        layout.content,
      );
      if (source) {
        const run = this.nativeTransition.begin(spaceId, token, source);
        if (run) {
          preparedTransition.nativeRun = run;
          this.activeTransitionToken = token;
        }
      }
    }
    return this.request({ kind: "space", spaceId }, preparedTransition).finally(() => {
      if (!token) return;
      this.nativeTransition?.cancel(token);
      this.expectedTransitionTokens.delete(token);
      if (this.activeTransitionToken === token) this.activeTransitionToken = "";
    });
  }

  refreshSpace(spaceId: number) {
    if (this.presentation.kind === "space" && this.presentation.spaceId === spaceId) {
      return this.request({ kind: "space", spaceId });
    }
    return Promise.resolve();
  }

  refreshControlOverlay() {
    this.syncControlOverlay();
  }

  notifyTransitionFinished(token: string) {
    // Retained as a protocol-compatible acknowledgement for older installed
    // skills/renderers. Native Core Animation no longer waits on a renderer
    // animation completion signal.
    return this.expectedTransitionTokens.has(token);
  }

  showAgentPointer(
    spaceId: number,
    pointer: { x: number; y: number; label: string },
  ) {
    if (this.overlaySpaceId !== spaceId || !this.views.overlay.webContents) return;
    this.views.overlay.webContents.send(
      "x-browser:agent-overlay-pointer",
      pointer,
    );
  }

  private request(
    next: Presentation,
    transition?: SpaceTransitionRequest,
    options: PresentationRequestOptions = {},
  ) {
    const generation = ++this.generation;
    this.commitQueue = this.commitQueue.then(async () => {
      if (generation !== this.generation) return;
      await this.commit(next, generation, transition, options);
    });
    return this.commitQueue;
  }

  private async commit(
    next: Presentation,
    generation: number,
    transition?: SpaceTransitionRequest,
    options: PresentationRequestOptions = {},
  ) {
    let nextPage: WebContentsView | null = null;
    let nextTargetId: string | null = null;
    if (next.kind === "space") {
      // Stop Overview capture before waiting for or attaching the real page.
      // A frame subscription that survives this transition can invalidate the
      // now-visible WebContents and make an otherwise normal load appear to
      // flash repeatedly.
      this.manager.setOverviewPreviewActive(false);
      nextTargetId = this.manager.getActiveTab(next.spaceId).targetId;
      // Attach the real WebContents as soon as its navigation starts. Chromium
      // can then paint its ordinary loading lifecycle instead of leaving the
      // Overview's last frame visible until loadURL fully resolves.
      nextPage = await this.manager.activeViewForPresentation(next.spaceId);
      await this.manager.prepareForPresentation(nextTargetId);
      if (generation !== this.generation) {
        this.manager.cancelPresentationPreparation(nextTargetId);
        void this.manager.parkAfterPresentation(nextTargetId).catch(() => undefined);
        return;
      }
    }

    const root = this.window.contentView;
    const previousPage = this.attachedPage;
    const previousTarget = previousPage ? this.findTargetId(previousPage) : undefined;

    if (
      next.kind === "space" &&
      this.presentation.kind === "overview" &&
      transition &&
      root.children.includes(this.views.overview) &&
      nextPage
    ) {
      const transitioned = await this.commitOverviewToSpaceTransition({
        next,
        generation,
        nextPage,
        nextTargetId,
        transition,
      }).catch(() => false);
      if (transitioned) return;
      if (transition.token) this.nativeTransition?.cancel(transition.token);
      if (generation !== this.generation) {
        this.manager.cancelPresentationPreparation(nextTargetId!);
        this.removeIfAttached(nextPage);
        this.removeIfAttached(this.views.browser);
        nextPage.setVisible(false);
        this.views.browser.setVisible(false);
        void this.manager.parkAfterPresentation(nextTargetId!).catch(
          () => undefined,
        );
        return;
      }
    }

    // Re-publishing the current Overview is a state refresh, not a native
    // view transition. Detaching and re-attaching the same shell creates a
    // visible empty compositor frame on macOS, especially after restore.
    if (
      this.presentation.kind === "overview" &&
      next.kind === "overview" &&
      root.children.includes(this.views.overview)
    ) {
      this.manager.setPresentedTarget(null);
      this.presentation = next;
      this.layout();
      this.syncControlOverlay();
      this.syncPreviewActivity();
      this.publishState();
      return;
    }

    // State-only refreshes are common while a page loads. Avoid detaching the
    // persistent browser shell or its page when the visible target is already
    // correct; doing so produces a needless white flash on every broadcast.
    if (
      this.presentation.kind === "space" &&
      next.kind === "space" &&
      previousPage === nextPage
    ) {
      this.manager.setPresentedTarget(nextTargetId);
      this.presentation = next;
      this.layout();
      this.syncControlOverlay();
      this.syncPreviewActivity();
      this.scheduleSnapshotRefresh(next.spaceId);
      return;
    }

    // Keep Browser Chrome attached while switching tabs or Spaces. The old
    // page is removed and the prepared replacement is attached synchronously;
    // background parking happens only after the new visible state is committed.
    if (this.presentation.kind === "space" && next.kind === "space") {
      const nativeChrome = this.nativeChrome?.isAvailable() === true;
      if (nextPage) this.setPageBounds(nextPage);
      if (previousPage && previousPage !== nextPage) {
        root.removeChildView(previousPage);
      }
      if (nextPage && previousPage !== nextPage) {
        root.addChildView(nextPage);
        nextPage.setVisible(true);
      }
      this.attachedPage = nextPage;
      if (nativeChrome) {
        this.removeIfAttached(this.views.browser);
        this.views.browser.setVisible(false);
        this.nativeChrome?.setVisible(true);
      }
      this.manager.setPresentedTarget(nextTargetId);
      this.presentation = next;
      this.layout();
      this.syncControlOverlay();
      this.syncPreviewActivity();
      this.publishState();
      this.scheduleSnapshotRefresh(next.spaceId);
      if (
        options.parkPrevious !== false &&
        previousTarget &&
        previousTarget !== nextTargetId
      ) {
        void this.manager.parkAfterPresentation(previousTarget).catch(() => undefined);
      }
      return;
    }

    // The first browser-focused milestone intentionally presents a pure
    // browser window. Keep the chat runtime alive but detached so it can be
    // reintroduced later without creating a second state/control system.
    if (next.kind === "overview") {
      const previousSpaceId =
        this.presentation.kind === "space"
          ? this.presentation.spaceId
          : undefined;
      const [width, height] = this.window.getContentSize();
      const layout = calculateShellLayout(width, height);
      this.views.overview.setBounds(layout.overview);

      let exitRun: NativeSpaceTransitionRun | undefined;
      let exitToken = "";
      let refreshSnapshotAfterExit = false;
      // AppKit view readback and PNG encoding are synchronous. On a first use
      // or after macOS has idled the backing store, doing that work here can
      // freeze the click before Overview is attached. The normal background
      // snapshot refresh already maintains an exact chrome image, so reuse it
      // on the latency-sensitive return path.
      const nativeChromePng = this.nativeChrome?.cachedPng();
      if (previousPage && previousSpaceId !== undefined && this.nativeTransition) {
        const target = this.resolveOverviewTarget(previousSpaceId, layout.content);
        if (target) {
          const beginExit = () => {
            exitToken = `overview-${previousSpaceId}-${Date.now().toString(36)}`;
            return this.nativeTransition?.beginExit(
              previousSpaceId,
              exitToken,
              target,
            );
          };
          if (this.nativeTransition.hasSnapshot(previousSpaceId)) {
            // A stable full-resolution frame is maintained while the Space is
            // visible. Starting from it removes capturePage from the click's
            // critical path, which is the difference between an immediate
            // native zoom and a visible pause before the first moving frame.
            exitRun = beginExit();
            refreshSnapshotAfterExit = Boolean(exitRun);
          }
          if (exitRun) this.activeTransitionToken = exitToken;
        }
      }
      // Attach the destination at full size before removing the browser and
      // page below it. The Overview is opaque, so this gives AppKit one
      // continuous surface instead of briefly exposing the BaseWindow
      // background between two native view trees.
      this.ensureAttached(this.views.overview);
      this.views.overview.setVisible(true);
      this.manager.setPresentedTarget(null);
      this.presentation = next;
      this.layout();
      this.nativeChrome?.setVisible(false);
      this.syncPreviewActivity();
      this.publishState();

      if (exitRun) {
        const remaining = this.nativeTransition?.remainingMs(exitToken) ?? 0;
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining));
        }
      }

      // Recent native macOS browsers keep a stable, full-resolution page
      // snapshot and hand it to Core Animation during the next switch. Capture
      // while Browser Chrome/page are still attached but already hidden below
      // the opaque Overview, so the user returns immediately and no readback
      // work is added to the next click's critical path.
      if (
        (!exitRun || refreshSnapshotAfterExit) &&
        previousPage &&
        previousSpaceId !== undefined &&
        this.nativeTransition
      ) {
        await this.nativeTransition
          .capture(
            previousSpaceId,
            this.views.browser,
            previousPage,
            {
              width,
              height,
              chromeHeight: layout.chrome.height,
            },
            nativeChromePng,
          )
          .catch(() => false);
      }

      if (previousPage) {
        this.removeIfAttached(previousPage);
        this.attachedPage = null;
      }
      this.removeIfAttached(this.views.browser);
      this.removeIfAttached(this.views.chat);
      this.views.browser.setVisible(false);
      this.views.chat.setVisible(false);
      if (exitRun) {
        this.nativeTransition?.finish(exitToken);
        if (this.activeTransitionToken === exitToken) {
          this.activeTransitionToken = "";
        }
      }
    } else {
      // The browser chrome and page together cover the complete destination
      // window. Stack them above Overview first, then retire Overview. This
      // preserves the last valid Overview pixels until the real page is ready
      // to be presented and removes the white flash during card activation.
      const [width, height] = this.window.getContentSize();
      const layout = calculateShellLayout(width, height);
      const nativeChrome = this.nativeChrome?.isAvailable() === true;
      if (nativeChrome) {
        this.removeIfAttached(this.views.browser);
        this.views.browser.setVisible(false);
        this.nativeChrome?.setVisible(true);
      } else {
        this.views.browser.setBounds(layout.chrome);
        this.ensureAttached(this.views.browser);
        this.views.browser.setVisible(true);
      }
      if (nextPage) {
        nextPage.setBounds(layout.page);
        this.ensureAttached(nextPage);
        nextPage.setVisible(true);
        this.attachedPage = nextPage;
        this.manager.setPresentedTarget(nextTargetId);
      }
      this.presentation = next;
      this.layout();

      this.removeIfAttached(this.views.overview);
      this.removeIfAttached(this.views.chat);
      this.views.overview.setVisible(false);
      this.views.chat.setVisible(false);
    }
    this.syncControlOverlay();
    this.syncPreviewActivity();
    this.publishState();
    if (next.kind === "space") this.scheduleSnapshotRefresh(next.spaceId);
    if (
      options.parkPrevious !== false &&
      previousTarget &&
      previousTarget !== nextTargetId
    ) {
      void this.manager.parkAfterPresentation(previousTarget).catch(() => undefined);
    }
  }

  layout() {
    if (this.window.isMinimized()) return;
    const [width, height] = this.window.getContentSize();
    const layout = calculateShellLayout(width, height);
    this.manager.setPageViewport(layout.page.width, layout.page.height);
    this.views.chat.setBounds(layout.chat);
    if (this.presentation.kind === "overview") {
      this.views.overview.setBounds(layout.overview);
    } else {
      if (this.nativeChrome?.isAvailable() !== true) {
        this.views.browser.setBounds(layout.chrome);
      }
      this.attachedPage?.setBounds(layout.page);
      if (this.overlaySpaceId !== null) this.views.overlay.setBounds(layout.overlay);
    }
  }

  private publishState() {
    const state = this.presentation;
    this.views.chat.webContents.send("x-browser:presentation", state);
    this.views.overview.webContents.send("x-browser:presentation", state);
    this.views.browser.webContents.send("x-browser:presentation", state);
  }

  private syncPreviewActivity() {
    this.manager.setOverviewPreviewActive(
      this.presentation.kind === "overview" &&
        this.window.isVisible() &&
        !this.window.isMinimized(),
    );
  }

  private syncControlOverlay() {
    if (this.activeTransitionToken) return;
    const current = this.presentation;
    const space =
      current.kind === "space" ? this.manager.getSpace(current.spaceId) : undefined;
    const controlled =
      space?.ownership === "agent" && space.lifecycle === "active";
    if (!space || !controlled) {
      const wasVisible = this.overlaySpaceId !== null;
      this.removeIfAttached(this.views.overlay);
      this.views.overlay.setVisible(false);
      this.overlaySpaceId = null;
      if (
        wasVisible &&
        current.kind === "space" &&
        this.window.isFocused()
      ) {
        const pageContents = this.attachedPage?.webContents;
        if (pageContents && !pageContents.isDestroyed()) pageContents.focus();
      }
      return;
    }

    const [width, height] = this.window.getContentSize();
    this.views.overlay.setBounds(calculateShellLayout(width, height).overlay);
    const root = this.window.contentView;
    const children = root.children;
    if (children.at(-1) !== this.views.overlay) {
      if (children.includes(this.views.overlay)) root.removeChildView(this.views.overlay);
      root.addChildView(this.views.overlay);
    }
    this.views.overlay.setVisible(true);
    const newlyVisible = this.overlaySpaceId !== space.id;
    this.overlaySpaceId = space.id;
    this.views.overlay.webContents.send("x-browser:agent-overlay-state", {
      spaceId: space.id,
      name: space.name,
      task: space.agentTask,
    });
    const overlayContents = this.views.overlay.webContents;
    if (
      overlayContents &&
      !overlayContents.isDestroyed() &&
      this.window.isFocused() &&
      (newlyVisible || !overlayContents.isFocused())
    ) {
      overlayContents.focus();
    }
  }

  private cancelSnapshotRefresh() {
    this.snapshotRefreshGeneration += 1;
    if (!this.snapshotRefreshTimer) return;
    clearTimeout(this.snapshotRefreshTimer);
    this.snapshotRefreshTimer = undefined;
  }

  private async captureVisibleSnapshot(spaceId: number) {
    const current = this.presentation;
    const page = this.attachedPage;
    if (
      !this.nativeTransition ||
      this.activeTransitionToken ||
      current.kind !== "space" ||
      current.spaceId !== spaceId ||
      !page ||
      page.webContents.isDestroyed() ||
      !this.manager.getSpace(spaceId)
    ) {
      return false;
    }
    if (this.manager.navigationState(spaceId).loading) {
      this.scheduleSnapshotRefresh(spaceId, 260);
      return false;
    }
    const nativeChromePng = this.nativeChrome?.capturePng();
    if (this.nativeChrome?.isAvailable() === true && !nativeChromePng) {
      this.scheduleSnapshotRefresh(spaceId, 120);
      return false;
    }
    const [width, height] = this.window.getContentSize();
    const layout = calculateShellLayout(width, height);
    return this.nativeTransition.capture(
      spaceId,
      this.views.browser,
      page,
      {
        width,
        height,
        chromeHeight: layout.chrome.height,
      },
      nativeChromePng,
    );
  }

  private removeIfAttached(view: WebContentsView) {
    if (!this.window.contentView.children.includes(view)) return;
    try {
      this.window.contentView.removeChildView(view);
    } catch {
      // Removing a detached view is harmless.
    }
  }

  private ensureAttached(view: WebContentsView) {
    if (this.window.contentView.children.includes(view)) return;
    this.window.contentView.addChildView(view);
  }

  private setPageBounds(view: WebContentsView) {
    const [width, height] = this.window.getContentSize();
    view.setBounds(calculateShellLayout(width, height).page);
  }

  private findTargetId(view: WebContentsView) {
    for (const space of this.manager.listSpaces()) {
      const target = space.tabs.find(
        (tab) => this.manager.getView(tab.targetId) === view,
      );
      if (target) return target.targetId;
    }
    return undefined;
  }

  private async commitOverviewToSpaceTransition(input: {
    next: Extract<Presentation, { kind: "space" }>;
    generation: number;
    nextPage: WebContentsView;
    nextTargetId: string | null;
    transition: SpaceTransitionRequest;
  }) {
    const { next, generation, nextPage, nextTargetId, transition } = input;
    const token = transition.token;
    if (!token || !this.expectedTransitionTokens.has(token)) return false;
    const [width, height] = this.window.getContentSize();
    const layout = calculateShellLayout(width, height);
    const source = this.clampTransitionSource(transition.source, layout.content);
    if (!source) return false;

    const root = this.window.contentView;
    const overviewIndex = root.children.indexOf(this.views.overview);
    if (overviewIndex < 0) return false;

    const nativeChrome = this.nativeChrome?.isAvailable() === true;
    if (!nativeChrome) this.views.browser.setBounds(layout.chrome);
    nextPage.setBounds(layout.page);
    if (nativeChrome) {
      this.removeIfAttached(this.views.browser);
      this.views.browser.setVisible(false);
      // Keep the live native chrome inside the destination window hidden while
      // the cached full-browser surface expands. Showing it here creates a
      // second, already-full-size toolbar above the moving snapshot.
      this.nativeChrome?.setVisible(false);
      this.attachAt(nextPage, overviewIndex);
    } else {
      this.attachAt(this.views.browser, overviewIndex);
      this.views.browser.setVisible(true);
      this.attachAt(nextPage, overviewIndex + 1);
    }
    nextPage.setVisible(true);
    this.activeTransitionToken = token;

    // The Overview renderer starts the card Hero animation synchronously in
    // the click handler. The real Browser Chrome/page are attached underneath
    // that opaque surface while it moves, so Chromium can compose normally
    // without capturePage(), JPEG encoding, renderer decoding, or a delayed
    // animation start. If preparation finishes early we wait for the Hero; if
    // it finishes late, Overview holds the full-window final frame until this
    // native swap is ready.
    // Native Core Animation is the single visual owner of Overview -> Space.
    // The old renderer Hero ran at the same time and remained visible through
    // the transparent part of this native panel, producing two differently
    // scaled browser surfaces and duplicated chrome on every intermediate
    // frame. If the native addon/snapshot is unavailable, commit directly
    // instead of bringing that competing renderer animation back.
    const transitionFinished = transition.nativeRun
      ? await this.waitForNativeTransition(token)
      : true;
    if (!transitionFinished || generation !== this.generation) {
      this.nativeTransition?.cancel(token);
      if (this.activeTransitionToken === token) this.activeTransitionToken = "";
      return false;
    }

    this.attachedPage = nextPage;
    this.manager.setPresentedTarget(nextTargetId);
    this.presentation = next;
    this.removeIfAttached(this.views.overview);
    this.removeIfAttached(this.views.chat);
    this.views.overview.setVisible(false);
    this.views.chat.setVisible(false);
    if (this.activeTransitionToken === token) this.activeTransitionToken = "";

    this.layout();
    this.syncControlOverlay();
    this.syncPreviewActivity();
    this.publishState();
    // The transition panel is still holding its exact full-window final frame.
    // Reveal the live in-window chrome behind it, then remove the panel for a
    // single-frame handoff with no floating toolbar or duplicate browser UI.
    if (nativeChrome) this.nativeChrome?.setVisible(true);
    this.nativeTransition?.finish(token);
    this.scheduleSnapshotRefresh(next.spaceId);
    return true;
  }

  private async waitForNativeTransition(token: string) {
    const remaining = this.nativeTransition?.remainingMs(token) ?? 0;
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    return true;
  }

  private clampTransitionSource(source: Rect, content: Rect): Rect | null {
    const x = Math.max(0, Math.min(source.x - content.x, content.width - 1));
    const y = Math.max(0, Math.min(source.y - content.y, content.height - 1));
    const width = Math.min(
      Math.max(1, source.width),
      Math.max(1, content.width - x),
    );
    const height = Math.min(
      Math.max(1, source.height),
      Math.max(1, content.height - y),
    );
    if (width < 32 || height < 32) return null;
    return { x, y, width, height };
  }

  private resolveOverviewTarget(spaceId: number, content: Rect) {
    const cached = this.overviewTargets.get(spaceId);
    if (cached) {
      const safe = this.clampTransitionSource(cached, content);
      if (safe) return safe;
    }
    return null;
  }

  private attachAt(view: WebContentsView, index: number) {
    const root = this.window.contentView;
    if (root.children.includes(view)) root.removeChildView(view);
    root.addChildView(view, Math.max(0, Math.min(index, root.children.length)));
  }

}
