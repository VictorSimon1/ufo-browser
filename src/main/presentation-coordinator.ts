import type { BaseWindow, NativeImage, WebContentsView } from "electron";
import { calculateShellLayout } from "./shell-page-bounds.js";
import type { Presentation, Rect } from "./types.js";
import { TaskSpaceManager } from "./manager.js";

type ShellViews = {
  chat: WebContentsView;
  overview: WebContentsView;
  browser: WebContentsView;
  overlay: WebContentsView;
};

type SpaceTransitionRequest = {
  source: Rect;
};

type PresentationRequestOptions = {
  parkPrevious?: boolean;
};

const SPACE_TRANSITION_DURATION_MS = 180;
const SPACE_TRANSITION_CAPTURE_TIMEOUT_MS = 260;
const SPACE_TRANSITION_READY_TIMEOUT_MS = 320;

export class PresentationCoordinator {
  private presentation: Presentation = { kind: "overview" };
  private generation = 0;
  private commitQueue = Promise.resolve();
  private attachedPage: WebContentsView | null = null;
  private overlaySpaceId: number | null = null;
  private activeTransitionToken = "";
  private transitionSequence = 0;
  private readonly transitionReadyWaiters = new Map<string, () => void>();
  private readonly transitionFinishedWaiters = new Map<string, () => void>();

  constructor(
    private readonly window: BaseWindow,
    private readonly views: ShellViews,
    private readonly manager: TaskSpaceManager,
  ) {
    this.window.on("resize", () => this.layout());
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
    this.syncControlOverlay();
    this.syncPreviewActivity();
    // The shell can receive its initial Presentation while the native window
    // is still hidden. Re-publish after show/restore so Overview schedules
    // visibility work against a live compositor instead of waiting for a
    // throttled hidden requestAnimationFrame to eventually run.
    this.publishState();
  }

  showOverview(options?: PresentationRequestOptions) {
    return this.request({ kind: "overview" }, undefined, options);
  }

  showSpace(spaceId: number, transition?: SpaceTransitionRequest) {
    return this.request({ kind: "space", spaceId }, transition);
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

  notifyTransitionReady(token: string) {
    return this.resolveTransitionWaiter(this.transitionReadyWaiters, token);
  }

  notifyTransitionFinished(token: string) {
    return this.resolveTransitionWaiter(this.transitionFinishedWaiters, token);
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
      return;
    }

    // Keep Browser Chrome attached while switching tabs or Spaces. The old
    // page is removed and the prepared replacement is attached synchronously;
    // background parking happens only after the new visible state is committed.
    if (this.presentation.kind === "space" && next.kind === "space") {
      if (nextPage) this.setPageBounds(nextPage);
      if (previousPage && previousPage !== nextPage) {
        root.removeChildView(previousPage);
      }
      if (nextPage && previousPage !== nextPage) {
        root.addChildView(nextPage);
        nextPage.setVisible(true);
      }
      this.attachedPage = nextPage;
      this.manager.setPresentedTarget(nextTargetId);
      this.presentation = next;
      this.layout();
      this.syncControlOverlay();
      this.syncPreviewActivity();
      this.publishState();
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
      // Attach the destination at full size before removing the browser and
      // page below it. The Overview is opaque, so this gives AppKit one
      // continuous surface instead of briefly exposing the BaseWindow
      // background between two native view trees.
      this.ensureAttached(this.views.overview);
      this.views.overview.setVisible(true);
      this.manager.setPresentedTarget(null);
      this.presentation = next;
      this.layout();

      if (previousPage) {
        this.removeIfAttached(previousPage);
        this.attachedPage = null;
      }
      this.removeIfAttached(this.views.browser);
      this.removeIfAttached(this.views.chat);
      this.views.browser.setVisible(false);
      this.views.chat.setVisible(false);
    } else {
      // The browser chrome and page together cover the complete destination
      // window. Stack them above Overview first, then retire Overview. This
      // preserves the last valid Overview pixels until the real page is ready
      // to be presented and removes the white flash during card activation.
      const [width, height] = this.window.getContentSize();
      const layout = calculateShellLayout(width, height);
      this.views.browser.setBounds(layout.chrome);
      this.ensureAttached(this.views.browser);
      this.views.browser.setVisible(true);
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
      this.views.browser.setBounds(layout.chrome);
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
    const [width, height] = this.window.getContentSize();
    const layout = calculateShellLayout(width, height);
    const source = this.clampTransitionSource(transition.source, layout.content);
    if (!source) return false;

    const root = this.window.contentView;
    const overviewIndex = root.children.indexOf(this.views.overview);
    if (overviewIndex < 0) return false;

    this.views.browser.setBounds(layout.chrome);
    nextPage.setBounds(layout.page);
    this.attachAt(this.views.browser, overviewIndex);
    this.attachAt(nextPage, overviewIndex + 1);
    this.views.browser.setVisible(true);
    nextPage.setVisible(true);

    // Browser state is sent before showSpace() enters this coordinator. Give
    // its renderer one compositor turn so the captured native Chrome matches
    // the destination underneath the transition exactly.
    await this.waitForRendererPaint(this.views.browser, 48);
    if (generation !== this.generation) return false;

    const [overviewFrame, chromeFrame, pageFrame] = await this.withTimeout(
      Promise.all([
        this.views.overview.webContents.capturePage(),
        this.views.browser.webContents.capturePage(),
        nextPage.webContents.capturePage(),
      ]),
      SPACE_TRANSITION_CAPTURE_TIMEOUT_MS,
    );
    if (overviewFrame.isEmpty() || chromeFrame.isEmpty() || pageFrame.isEmpty()) {
      return false;
    }
    if (generation !== this.generation) return false;

    const token = `${generation}-${++this.transitionSequence}`;
    this.activeTransitionToken = token;
    this.views.overlay.setBounds(layout.content);
    this.ensureAttached(this.views.overlay);
    this.views.overlay.setVisible(true);
    const ready = this.waitForTransitionSignal(
      this.transitionReadyWaiters,
      token,
      SPACE_TRANSITION_READY_TIMEOUT_MS,
    );
    this.views.overlay.webContents.send("x-browser:space-transition", {
      phase: "prepare",
      token,
      durationMs: SPACE_TRANSITION_DURATION_MS,
      source,
      viewport: { width: layout.content.width, height: layout.content.height },
      chromeHeight: layout.chrome.height,
      pageHeight: layout.page.height,
      overview: this.transitionImageDataUrl(
        overviewFrame,
        layout.content.width,
        88,
      ),
      chrome: this.transitionImageDataUrl(
        chromeFrame,
        layout.chrome.width,
        92,
      ),
      page: this.transitionImageDataUrl(pageFrame, layout.page.width, 88),
    });
    if (!(await ready) || generation !== this.generation) {
      this.cancelSpaceTransition(token);
      return false;
    }

    this.attachedPage = nextPage;
    this.manager.setPresentedTarget(nextTargetId);
    this.presentation = next;
    this.removeIfAttached(this.views.overview);
    this.removeIfAttached(this.views.chat);
    this.views.overview.setVisible(false);
    this.views.chat.setVisible(false);

    const finished = this.waitForTransitionSignal(
      this.transitionFinishedWaiters,
      token,
      SPACE_TRANSITION_DURATION_MS + 260,
    );
    this.views.overlay.webContents.send("x-browser:space-transition", {
      phase: "go",
      token,
    });
    const didFinish = await finished;
    this.transitionReadyWaiters.delete(token);
    this.transitionFinishedWaiters.delete(token);
    if (!didFinish) this.cancelSpaceTransition(token);
    if (this.activeTransitionToken === token) this.activeTransitionToken = "";

    this.layout();
    this.syncControlOverlay();
    this.syncPreviewActivity();
    this.publishState();
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

  private attachAt(view: WebContentsView, index: number) {
    const root = this.window.contentView;
    if (root.children.includes(view)) root.removeChildView(view);
    root.addChildView(view, Math.max(0, Math.min(index, root.children.length)));
  }

  private waitForRendererPaint(view: WebContentsView, timeoutMs: number) {
    if (view.webContents.isDestroyed()) return Promise.resolve();
    return this.withTimeout(
      view.webContents.executeJavaScript(
        `new Promise((resolve) => requestAnimationFrame(() => resolve(true)))`,
        true,
      ),
      timeoutMs,
    ).then(() => undefined, () => undefined);
  }

  private waitForTransitionSignal(
    waiters: Map<string, () => void>,
    token: string,
    timeoutMs: number,
  ) {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!waiters.delete(token)) return;
        resolve(false);
      }, timeoutMs);
      waiters.set(token, () => {
        clearTimeout(timer);
        waiters.delete(token);
        resolve(true);
      });
    });
  }

  private resolveTransitionWaiter(
    waiters: Map<string, () => void>,
    token: string,
  ) {
    const resolve = waiters.get(token);
    if (!resolve) return false;
    resolve();
    return true;
  }

  private cancelSpaceTransition(token: string) {
    this.transitionReadyWaiters.delete(token);
    this.transitionFinishedWaiters.delete(token);
    if (!this.views.overlay.webContents.isDestroyed()) {
      this.views.overlay.webContents.send("x-browser:space-transition", {
        phase: "cancel",
        token,
      });
    }
    if (this.activeTransitionToken === token) this.activeTransitionToken = "";
    if (this.overlaySpaceId === null) {
      this.removeIfAttached(this.views.overlay);
      this.views.overlay.setVisible(false);
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Space transition timed out")),
        timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private transitionImageDataUrl(
    image: NativeImage,
    targetWidth: number,
    quality: number,
  ) {
    const size = image.getSize();
    const frame =
      size.width > targetWidth
        ? image.resize({ width: targetWidth, quality: "good" })
        : image;
    return `data:image/jpeg;base64,${frame.toJPEG(quality).toString("base64")}`;
  }
}
