import type { BaseWindow, WebContentsView } from "electron";
import { calculateShellLayout } from "./shell-page-bounds.js";
import type { Presentation } from "./types.js";
import { TaskSpaceManager } from "./manager.js";

type ShellViews = {
  chat: WebContentsView;
  overview: WebContentsView;
  browser: WebContentsView;
  overlay: WebContentsView;
};

export class PresentationCoordinator {
  private presentation: Presentation = { kind: "overview" };
  private generation = 0;
  private commitQueue = Promise.resolve();
  private attachedPage: WebContentsView | null = null;
  private overlaySpaceId: number | null = null;

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

  showOverview() {
    return this.request({ kind: "overview" });
  }

  showSpace(spaceId: number) {
    return this.request({ kind: "space", spaceId });
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

  private request(next: Presentation) {
    const generation = ++this.generation;
    this.commitQueue = this.commitQueue.then(async () => {
      if (generation !== this.generation) return;
      await this.commit(next, generation);
    });
    return this.commitQueue;
  }

  private async commit(next: Presentation, generation: number) {
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
      if (previousTarget && previousTarget !== nextTargetId) {
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
    if (previousTarget && previousTarget !== nextTargetId) {
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
      if (this.overlaySpaceId !== null) this.views.overlay.setBounds(layout.page);
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
        this.attachedPage?.webContents.focus();
      }
      return;
    }

    const [width, height] = this.window.getContentSize();
    this.views.overlay.setBounds(calculateShellLayout(width, height).page);
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
    if (
      this.window.isFocused() &&
      (newlyVisible || !this.views.overlay.webContents.isFocused())
    ) {
      this.views.overlay.webContents.focus();
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
}
