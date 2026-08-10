import { randomUUID } from "node:crypto";
import type {
  BaseWindow,
  BrowserWindowConstructorOptions,
  NativeImage,
  Rectangle,
  WebContentsView,
} from "electron";
import {
  nativeImage,
  session,
  WebContentsView as ElectronWebContentsView,
} from "electron";
import { BrowserStateStore } from "./state-store.js";
import { BrowserProfileRegistry } from "./profile-registry.js";
import type {
  BrowserState,
  PublicSpace,
  SpaceLifecycle,
  SpaceOwnership,
  SpaceRecord,
  TabRecord,
} from "./types.js";
import {
  isDefaultNewTabUrl,
  isInternalNewTabUrl,
  logicalNavigationUrl,
  normalizeNavigationUrl,
  X_BROWSER_DEFAULT_NEW_TAB_URL,
} from "./internal-pages.js";
import {
  configureChromiumSession,
  ensureChromiumProfilePreferences,
} from "./chromium-identity.js";
import { BROWSER_CHROME_HEIGHT } from "./shell-page-bounds.js";
import { selectPreviewCaptureIds } from "./preview-visibility.js";
import { bitmapHasVisualDetail } from "./preview-quality.js";
import {
  overviewPreviewDelay,
  previewVisualChanged,
  quantizedPreviewSignature,
} from "./preview-cadence.js";

type TabRuntime = {
  view: WebContentsView;
  loaded: boolean;
  loading: Promise<void>;
  retained: boolean;
  nativePopup: boolean;
  frameName?: string;
};

type PreviewCacheEntry = {
  data?: Buffer;
  capturedAt: number;
  revision: number;
  pending?: Promise<Buffer>;
};

type PreviewFrame = {
  spaceId: number;
  revision: number;
  data: Buffer;
};

const MAX_PREVIEW_CACHE_ENTRIES = 24;
const MAX_PREVIEW_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_RECOVERY_ATTEMPTS = 4;
// Ego restores real Space tabs on launch and keeps their renderer state alive
// while Overview shows thumbnails. Match that lifecycle for the bounded set of
// visible cards: detached WebContents keep DOM/navigation state but own no live
// AppKit/Viz surface, so entry is instant without multiplying GPU surfaces.
const MAX_PARKED_RESTORE_RUNTIMES = 8;

type OverviewScreencastState = {
  spaceId: number;
  targetId: string;
  contentsId: number;
  generation: number;
  listener: (image: NativeImage, dirtyRect: Rectangle) => void;
  subscriptionActive: boolean;
  resubscribeTimer?: ReturnType<typeof setTimeout>;
  frameTimeout?: ReturnType<typeof setTimeout>;
  startedAt: number;
  lastFrameAt: number;
  lastPublishedAt: number;
  receivedFrames: number;
  publishedFrames: number;
  unchangedFrames: number;
  lastActivityAt: number;
  nextFrameDelayMs: number;
  lastVisualSignature?: Uint8Array;
};

type ManagerOptions = {
  store: BrowserStateStore;
  profiles: BrowserProfileRegistry;
  partitionsRoot: string;
  pagePreload: string;
  captureWindow: BaseWindow;
  publishPreviewFrame: (frame: PreviewFrame) => void;
  forcedPreviewSpaceId?: number;
  forceColdPreviewCaptureFailure?: boolean;
  beforeProfileSessionSetup?: (profileId: string) => Promise<unknown>;
};

export class TaskSpaceManager {
  private state: BrowserState = { version: 1, nextSpaceId: 1, spaces: [] };
  private readonly runtimes = new Map<string, TabRuntime>();
  private readonly runtimeStarts = new Map<string, Promise<TabRuntime>>();
  private readonly mutationQueues = new Map<number, Promise<unknown>>();
  private readonly activeAgentConnections = new Set<number>();
  private readonly listeners = new Set<() => void>();
  private readonly controlListeners = new Set<(spaceId: number) => void>();
  private readonly agentPointerListeners = new Set<
    (spaceId: number, pointer: { x: number; y: number; label: string }) => void
  >();
  private readonly activeTabListeners = new Set<
    (spaceId: number, targetId: string) => void | Promise<void>
  >();
  private readonly beforeSpaceCloseListeners = new Set<
    (spaceId: number) => void | Promise<void>
  >();
  private presentedTargetId: string | null = null;
  private presentationReservedTargetId: string | null = null;
  private readonly hiddenSurfaceTargets = new Set<string>();
  private readonly backgroundVisibilityPrimedTargets = new Set<string>();
  private readonly surfaceGenerations = new Map<string, number>();
  private readonly profileSessionSetup = new Map<string, Promise<void>>();
  private readonly previewCache = new Map<string, PreviewCacheEntry>();
  private readonly publishedPreviewRevision = new Map<number, number>();
  private readonly visiblePreviewSpaceIds = new Set<number>();
  private readonly previewDueAt = new Map<number, number>();
  private readonly previewCaptures = new Set<number>();
  private readonly coldPreviewCaptures = new Set<number>();
  private readonly previewWarmupTargets = new Set<string>();
  private readonly parkedRestoreTargets = new Set<string>();
  private readonly previewQualityAttempts = new Map<number, number>();
  private readonly previewQualityRetryTargets = new Map<number, string>();
  private readonly previewPhases = new Map<number, string>();
  private readonly previewErrors = new Map<number, string>();
  private readonly frameSubscriptionCaptures = new Set<string>();
  private readonly overviewScreencastSuspendedTargets = new Set<string>();
  private readonly overviewScreencastRetryAt = new Map<string, number>();
  private readonly foregroundCadenceReasons = new Map<string, Set<string>>();
  private previewActive = false;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private previewRevision = 0;
  private previewCacheEvictions = 0;
  private overviewScreencast?: OverviewScreencastState;
  private overviewScreencastGeneration = 0;
  private overviewScreencastQueue = Promise.resolve();
  private overviewFramePauseDepth = 0;
  private surfaceQueue = Promise.resolve();
  private pageViewport = { width: 1280, height: 720 };

  constructor(private readonly options: ManagerOptions) {}

  async initialize() {
    this.state = await this.options.store.load();
    // Profile Sessions are created lazily by createSpace/ensureTabRuntime.
    // This keeps startup light and lets the storage-sync gate run while the
    // already-loaded Overview can show its real progress strip.
  }

  onChanged(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onControlChanged(listener: (spaceId: number) => void) {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  onAgentPointer(
    listener: (
      spaceId: number,
      pointer: { x: number; y: number; label: string },
    ) => void,
  ) {
    this.agentPointerListeners.add(listener);
    return () => this.agentPointerListeners.delete(listener);
  }

  onActiveTabChanged(
    listener: (spaceId: number, targetId: string) => void | Promise<void>,
  ) {
    this.activeTabListeners.add(listener);
    return () => this.activeTabListeners.delete(listener);
  }

  onBeforeSpaceClose(listener: (spaceId: number) => void | Promise<void>) {
    this.beforeSpaceCloseListeners.add(listener);
    return () => this.beforeSpaceCloseListeners.delete(listener);
  }

  listSpaces(): PublicSpace[] {
    return this.state.spaces.map((space) => ({
      ...structuredClone(space),
      recentTabTitles: space.tabs
        .map((tab) => tab.title)
        .filter(Boolean)
        .slice(-3),
    }));
  }

  listProfiles() {
    return this.options.profiles.listPublic().map(({ id, isDefault, name }) => ({
      id: id === "default" ? "Default" : id,
      isDefault,
      name,
    }));
  }

  getSpace(spaceId: number) {
    return this.state.spaces.find((space) => space.id === spaceId);
  }

  getSpaceOrThrow(spaceId: number) {
    const space = this.getSpace(spaceId);
    if (!space) throw new Error(`task space not found: ${spaceId}`);
    return space;
  }

  findSpaceByWebContentsId(webContentsId: number) {
    for (const space of this.state.spaces) {
      const tab = space.tabs.find((candidate) => {
        const runtime = this.runtimes.get(candidate.targetId);
        return runtime?.view.webContents.id === webContentsId;
      });
      if (tab) return { space, tab };
    }
    return undefined;
  }

  findSpaceByTargetId(targetId: string) {
    const space = this.state.spaces.find((candidate) =>
      candidate.tabs.some((tab) => tab.targetId === targetId),
    );
    return space;
  }

  async createSpace(
    name: string,
    createdBy: "agent" | "user" = "user",
    profileId?: string,
  ) {
    const profile = profileId
      ? this.options.profiles.getOrThrow(profileId)
      : this.options.profiles.getDefault();
    const trimmed = name.trim() || `Space ${this.state.nextSpaceId}`;
    const now = Date.now();
    const tab = this.newTabRecord(X_BROWSER_DEFAULT_NEW_TAB_URL);
    const space: SpaceRecord = {
      id: this.state.nextSpaceId++,
      taskId: trimmed,
      name: trimmed,
      createdBy,
      ownership: createdBy === "agent" ? "agent" : "user",
      lifecycle: "active",
      profileId: profile.id,
      tabs: [tab],
      activeTabId: tab.targetId,
      agentTask:
        createdBy === "agent"
          ? {
              title: trimmed,
              detail: "Agent is preparing the browser",
              completed: 0,
              total: 1,
              updatedAt: now,
            }
          : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.state.spaces.push(space);
    await this.persistAndNotify();
    return structuredClone(space);
  }

  async renameSpace(spaceId: number, name: string) {
    return this.mutate(spaceId, async (space) => {
      space.name = name.trim() || space.name;
      space.taskId = space.name;
      space.updatedAt = Date.now();
    });
  }

  async closeSpace(spaceId: number) {
    return this.enqueue(spaceId, async () => {
      if (!this.state.spaces.some((space) => space.id === spaceId)) return false;
      // The currently presented native page must be detached while its
      // WebContents is still alive. Destroying it first leaves AppKit with a
      // black child surface and makes overlay focus restoration race a missing
      // webContents object.
      for (const listener of this.beforeSpaceCloseListeners) {
        await listener(spaceId);
      }
      const index = this.state.spaces.findIndex((space) => space.id === spaceId);
      if (index < 0) return false;
      const [space] = this.state.spaces.splice(index, 1);
      this.activeAgentConnections.delete(spaceId);
      for (const tab of space.tabs) this.destroyRuntime(tab.targetId);
      this.visiblePreviewSpaceIds.delete(spaceId);
      this.previewDueAt.delete(spaceId);
      this.previewQualityAttempts.delete(spaceId);
      this.previewQualityRetryTargets.delete(spaceId);
      this.publishedPreviewRevision.delete(spaceId);
      this.requestOverviewScreencastReconcile();
      await this.persistAndNotify();
      return true;
    });
  }

  async createTab(spaceId: number, input = X_BROWSER_DEFAULT_NEW_TAB_URL) {
    let created!: TabRecord;
    await this.mutate(spaceId, async (space) => {
      created = this.newTabRecord(normalizeNavigationUrl(input));
      space.tabs.push(created);
      space.activeTabId = created.targetId;
      space.updatedAt = Date.now();
    });
    // A browser tab should become presentable as soon as Chromium starts its
    // navigation. Waiting for loadURL here leaves the previous tab on screen
    // and makes the eventual swap look like a frozen final-frame transition.
    const runtime = await this.ensureTabRuntimeStarted(spaceId, created.targetId);
    this.retainRuntime(created.targetId, runtime);
    await this.emitActiveTabChanged(spaceId, created.targetId);
    return structuredClone(created);
  }

  async createAgentTab(spaceId: number, input = X_BROWSER_DEFAULT_NEW_TAB_URL) {
    const space = this.getSpaceOrThrow(spaceId);
    const initialTab = space.tabs[0];
    const canReuseInitialTab =
      space.tabs.length === 1 &&
      space.activeTabId === initialTab?.targetId &&
      isDefaultNewTabUrl(initialTab?.url || "");
    if (!canReuseInitialTab) {
      return this.createTab(spaceId, input);
    }

    const url = normalizeNavigationUrl(input);
    let reused!: TabRecord;
    await this.mutate(spaceId, async (current) => {
      const tab = current.tabs[0];
      if (
        current.tabs.length !== 1 ||
        current.activeTabId !== tab?.targetId ||
        !isDefaultNewTabUrl(tab?.url || "")
      ) {
        return;
      }
      tab.url = url;
      tab.title = "New Tab";
      current.updatedAt = Date.now();
      reused = tab;
    });
    if (!reused) {
      // Another operation changed the Space while this request was queued.
      // Preserve ordinary new-tab semantics instead of replacing real work.
      return this.createTab(spaceId, input);
    }

    const existing = this.runtimes.get(reused.targetId);
    if (existing) {
      // A visible Overview may already be loading Google. A new explicit
      // navigation safely interrupts that request; do not wait on the network
      // before allowing an Agent to reuse the pristine initial tab.
      existing.loaded = false;
      this.retainRuntime(reused.targetId, existing);
      existing.loading = this.loadTab(existing, url);
    } else {
      const runtime = await this.ensureTabRuntimeStarted(spaceId, reused.targetId);
      this.retainRuntime(reused.targetId, runtime);
    }
    this.previewCache.delete(reused.targetId);
    if (this.visiblePreviewSpaceIds.has(spaceId)) {
      this.previewDueAt.set(spaceId, 0);
      this.schedulePreviewPump(0);
    }
    this.requestOverviewScreencastReconcile();
    return structuredClone(reused);
  }

  async activateTab(spaceId: number, targetId: string) {
    const alreadyActive = this.getSpaceOrThrow(spaceId).activeTabId === targetId;
    await this.mutate(spaceId, async (space) => {
      if (!space.tabs.some((tab) => tab.targetId === targetId)) {
        throw new Error(`tab not found: ${targetId}`);
      }
      space.activeTabId = targetId;
      space.updatedAt = Date.now();
    });
    // Cold tabs follow the same lifecycle as an ordinary browser: switch to
    // the real WebContents immediately and let it paint its loading state.
    const runtime = await this.ensureTabRuntimeStarted(spaceId, targetId);
    this.retainRuntime(targetId, runtime);
    this.requestOverviewScreencastReconcile();
    if (!alreadyActive) await this.emitActiveTabChanged(spaceId, targetId);
    return runtime.view;
  }

  async reorderTab(
    spaceId: number,
    targetId: string,
    beforeTargetId: string | null,
  ) {
    await this.mutate(spaceId, async (space) => {
      const fromIndex = space.tabs.findIndex(
        (tab) => tab.targetId === targetId,
      );
      if (fromIndex < 0) throw new Error(`tab not found: ${targetId}`);
      if (beforeTargetId === targetId) return;
      if (
        beforeTargetId !== null &&
        !space.tabs.some((tab) => tab.targetId === beforeTargetId)
      ) {
        throw new Error(`tab not found: ${beforeTargetId}`);
      }
      const [tab] = space.tabs.splice(fromIndex, 1);
      const insertIndex =
        beforeTargetId === null
          ? space.tabs.length
          : space.tabs.findIndex(
              (candidate) => candidate.targetId === beforeTargetId,
            );
      space.tabs.splice(insertIndex, 0, tab);
      space.updatedAt = Date.now();
    });
  }

  async closeTab(spaceId: number, targetId: string) {
    const wasActive = this.getSpaceOrThrow(spaceId).activeTabId === targetId;
    await this.mutateSoon(spaceId, async (space) => {
      const index = space.tabs.findIndex((tab) => tab.targetId === targetId);
      if (index < 0) throw new Error(`tab not found: ${targetId}`);
      space.tabs.splice(index, 1);
      this.destroyRuntime(targetId);
      if (space.tabs.length === 0) {
        const replacement = this.newTabRecord(X_BROWSER_DEFAULT_NEW_TAB_URL);
        space.tabs.push(replacement);
      }
      if (!space.tabs.some((tab) => tab.targetId === space.activeTabId)) {
        // Match Ego/Chromium tab closing semantics: keep moving forward when
        // a right neighbour exists, and only fall back left at the end.
        space.activeTabId =
          space.tabs[Math.min(index, space.tabs.length - 1)].targetId;
      }
      space.updatedAt = Date.now();
    });
    this.requestOverviewScreencastReconcile();
    if (wasActive) {
      await this.emitActiveTabChanged(
        spaceId,
        this.getSpaceOrThrow(spaceId).activeTabId,
      );
    }
  }

  async activeView(spaceId: number) {
    const space = this.getSpaceOrThrow(spaceId);
    return this.ensureTabRuntime(spaceId, space.activeTabId);
  }

  flushState() {
    return this.options.store.flush();
  }

  async activeViewForPresentation(spaceId: number) {
    const space = this.getSpaceOrThrow(spaceId);
    const runtime = await this.ensureTabRuntimeStarted(
      spaceId,
      space.activeTabId,
    );
    this.retainRuntime(space.activeTabId, runtime);
    return runtime.view;
  }

  async ensureTabRuntime(spaceId: number, targetId: string) {
    const runtime = await this.ensureTabRuntimeStarted(spaceId, targetId);
    this.retainRuntime(targetId, runtime);
    await runtime.loading;
    return runtime.view;
  }

  private retainRuntime(targetId: string, runtime: TabRuntime) {
    runtime.retained = true;
    this.parkedRestoreTargets.delete(targetId);
  }

  private async ensureTabRuntimeStarted(spaceId: number, targetId: string) {
    const existing = this.runtimes.get(targetId);
    if (existing) return existing;
    const starting = this.runtimeStarts.get(targetId);
    if (starting) return starting;

    const pending = this.createTabRuntime(spaceId, targetId);
    this.runtimeStarts.set(targetId, pending);
    try {
      return await pending;
    } finally {
      if (this.runtimeStarts.get(targetId) === pending) {
        this.runtimeStarts.delete(targetId);
      }
    }
  }

  private async createTabRuntime(spaceId: number, targetId: string) {
    const initialSpace = this.getSpaceOrThrow(spaceId);
    const profileId = initialSpace.profileId;
    if (!initialSpace.tabs.some((candidate) => candidate.targetId === targetId)) {
      throw new Error(`tab not found: ${targetId}`);
    }

    await this.ensureProfileSessionSetup(profileId);
    const space = this.getSpaceOrThrow(spaceId);
    const tab = space.tabs.find((candidate) => candidate.targetId === targetId);
    if (!tab) throw new Error(`tab not found: ${targetId}`);
    const existing = this.runtimes.get(targetId);
    if (existing) return existing;
    const profile = this.options.profiles.getOrThrow(profileId);

    const view = new ElectronWebContentsView({
      webPreferences: {
        preload: this.options.pagePreload,
        partition: `persist:${profile.partitionId}`,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        // Page state must survive while detached, but hidden tabs should use
        // Chromium's native timer/animation throttling. Agent commands attach
        // the target to the shared compositor surface before input, capture,
        // waits, or Turnstile work, restoring foreground-rate execution only
        // for the bounded lifetime of the CLI transaction.
        backgroundThrottling: true,
        sandbox: true,
        spellcheck: true,
      },
    });
    view.setBackgroundColor("#ffffff");
    const runtime: TabRuntime = {
      view,
      loaded: false,
      loading: Promise.resolve(),
      retained: false,
      nativePopup: false,
    };
    this.runtimes.set(targetId, runtime);
    this.bindTabRuntime(spaceId, targetId, runtime);
    runtime.loading = this.loadTab(runtime, tab.url);
    return runtime;
  }

  setPresentedTarget(targetId: string | null) {
    const previousTargetId = this.presentedTargetId;
    this.presentedTargetId = targetId;
    this.presentationReservedTargetId = targetId;
    if (previousTargetId && previousTargetId !== targetId) {
      this.bumpSurfaceGeneration(previousTargetId);
    }
  }

  setPageViewport(width: number, height: number) {
    if (width > 1 && height > 1) {
      this.pageViewport = {
        width: Math.floor(width),
        height: Math.floor(height),
      };
    }
  }

  setPageForegroundCadence(
    targetId: string,
    reason: string,
    active: boolean,
  ) {
    const runtime = this.runtimes.get(targetId);
    if (!runtime || runtime.view.webContents.isDestroyed()) {
      this.foregroundCadenceReasons.delete(targetId);
      return;
    }
    const reasons = this.foregroundCadenceReasons.get(targetId) ?? new Set();
    if (active) reasons.add(reason);
    else reasons.delete(reason);
    if (reasons.size > 0) {
      this.foregroundCadenceReasons.set(targetId, reasons);
      runtime.view.webContents.setBackgroundThrottling(false);
      return;
    }
    this.foregroundCadenceReasons.delete(targetId);
    runtime.view.webContents.setBackgroundThrottling(true);
  }

  setOverviewPreviewActive(active: boolean) {
    this.previewActive = active;
    if (!active) {
      if (this.previewTimer) clearTimeout(this.previewTimer);
      this.previewTimer = undefined;
      // End the compositor subscription immediately. Reconciliation still
      // performs the asynchronous surface cleanup, but it must not keep
      // invalidating a page after that page becomes the visible browser tab.
      const screencast = this.overviewScreencast;
      if (screencast) {
        if (screencast.resubscribeTimer) {
          clearTimeout(screencast.resubscribeTimer);
          screencast.resubscribeTimer = undefined;
        }
        this.endOverviewFrameSubscription(screencast);
      }
      for (const [spaceId, targetId] of this.previewQualityRetryTargets) {
        this.previewQualityAttempts.delete(spaceId);
        void this.releasePreviewOnlyRuntime(targetId).catch(() => undefined);
      }
      this.previewQualityRetryTargets.clear();
      this.requestOverviewScreencastReconcile();
      return;
    }
    this.prewarmVisiblePreviewRuntimes();
    this.requestOverviewScreencastReconcile();
    this.schedulePreviewPump(0);
  }

  setVisiblePreviewSpaces(spaceIds: number[]) {
    const requestedSpaceIds = Number.isSafeInteger(
      this.options.forcedPreviewSpaceId,
    ) && Number(this.options.forcedPreviewSpaceId) > 0
      ? [Number(this.options.forcedPreviewSpaceId)]
      : spaceIds;
    const next = new Set(
      requestedSpaceIds
        .filter((id) => Number.isSafeInteger(id) && Boolean(this.getSpace(id)))
        .slice(0, 8),
    );
    for (const id of this.visiblePreviewSpaceIds) {
      if (next.has(id)) continue;
      this.previewDueAt.delete(id);
      this.previewQualityAttempts.delete(id);
      const retryTarget = this.previewQualityRetryTargets.get(id);
      this.previewQualityRetryTargets.delete(id);
      if (retryTarget) {
        this.parkedRestoreTargets.delete(retryTarget);
        void this.releasePreviewOnlyRuntime(retryTarget).catch(() => undefined);
      }
      const offscreenTarget = this.getSpace(id)?.activeTabId;
      if (offscreenTarget && offscreenTarget !== retryTarget) {
        this.parkedRestoreTargets.delete(offscreenTarget);
        // A restored Agent-owned Space can briefly become the primary preview
        // before the renderer publishes its real visible cards. Once it is
        // offscreen, release that preview-only runtime just like a user Space.
        // Live Agent/CDP pages are retained and are rejected by the cleanup
        // guard, so browser work continues independently of Overview scroll.
        void this.releasePreviewOnlyRuntime(offscreenTarget).catch(
          () => undefined,
        );
      }
    }
    const now = Date.now();
    for (const id of next) {
      const cached = this.cachedPreviewForSpace(id);
      if (cached?.data) {
        // Renderer visibility publication is also the acknowledgement that
        // its cards and frame listener exist. Replaying the latest bounded
        // cache here closes the startup race where an early capture was sent
        // before the corresponding Canvas entered the DOM. The renderer
        // ignores duplicate revisions, so resize/scroll republishes are cheap.
        this.options.publishPreviewFrame({
          spaceId: id,
          revision: cached.revision,
          data: cached.data,
        });
        this.publishedPreviewRevision.set(id, cached.revision);
      }
      if (!this.visiblePreviewSpaceIds.has(id)) {
        const targetId = this.getSpace(id)?.activeTabId;
        const runtimeWarm = Boolean(targetId && this.runtimes.has(targetId));
        this.previewDueAt.set(
          id,
          cached?.data
            ? now + 700
            : runtimeWarm
              ? 0
              : now + 180,
        );
      }
    }
    this.visiblePreviewSpaceIds.clear();
    for (const id of next) this.visiblePreviewSpaceIds.add(id);
    this.prewarmVisiblePreviewRuntimes();
    this.requestOverviewScreencastReconcile();
    this.schedulePreviewPump(0);
  }

  private prewarmVisiblePreviewRuntimes() {
    if (!this.previewActive) return;
    for (const spaceId of this.visiblePreviewSpaceIds) {
      const space = this.getSpace(spaceId);
      if (!space) continue;
      const targetId = space.activeTabId;
      const existing = this.runtimes.get(targetId);
      if (existing) this.parkRestoredPreviewRuntime(spaceId, targetId);
      if (existing?.loaded || this.previewWarmupTargets.has(targetId)) continue;
      this.previewWarmupTargets.add(targetId);
      void (async () => {
        const runtime = existing ?? await this.ensureTabRuntimeStarted(spaceId, targetId);
        const current = this.getSpace(spaceId);
        if (
          !this.previewActive ||
          !this.visiblePreviewSpaceIds.has(spaceId) ||
          current?.activeTabId !== targetId
        ) {
          await this.releasePreviewOnlyRuntime(targetId);
          return;
        }
        this.parkRestoredPreviewRuntime(spaceId, targetId);
        await runtime.loading;
        if (
          this.previewActive &&
          this.visiblePreviewSpaceIds.has(spaceId) &&
          this.getSpace(spaceId)?.activeTabId === targetId
        ) {
          this.previewDueAt.set(spaceId, 0);
          this.schedulePreviewPump(0);
        }
      })()
        .catch((error) => {
          const current = this.getSpace(spaceId);
          if (
            this.previewActive &&
            this.visiblePreviewSpaceIds.has(spaceId) &&
            current?.activeTabId === targetId
          ) {
            this.previewErrors.set(spaceId, String(error));
            this.previewDueAt.set(spaceId, Date.now() + 800);
            this.schedulePreviewPump(800);
          }
        })
        .finally(() => this.previewWarmupTargets.delete(targetId));
    }
  }

  async suspendOverviewScreencast(targetId: string) {
    this.overviewScreencastSuspendedTargets.add(targetId);
    await this.requestOverviewScreencastReconcile();
  }

  resumeOverviewScreencast(targetId: string) {
    if (!this.overviewScreencastSuspendedTargets.delete(targetId)) return;
    this.requestOverviewScreencastReconcile();
  }

  previewDiagnostics() {
    const runtimes = this.state.spaces.flatMap((space) =>
      space.tabs.map((tab) => {
        const runtime = this.runtimes.get(tab.targetId);
        const contents = runtime?.view.webContents;
        const destroyed = contents?.isDestroyed() ?? false;
        let osProcessId = 0;
        let frames: Array<{
          url: string;
          origin: string;
          name: string;
          main: boolean;
          osProcessId: number;
          processId: number;
          routingId: number;
          frameTreeNodeId: number;
        }> = [];
        if (contents && !destroyed) {
          try {
            osProcessId = contents.getOSProcessId();
            const mainFrame = contents.mainFrame;
            frames = mainFrame.framesInSubtree.map((frame) => ({
              url: frame.url,
              origin: frame.origin,
              name: frame.name,
              main: frame === mainFrame,
              osProcessId: frame.osProcessId,
              processId: frame.processId,
              routingId: frame.routingId,
              frameTreeNodeId: frame.frameTreeNodeId,
            }));
          } catch {
            // A renderer/frame can exit while diagnostics traverse the tree.
          }
        }
        return {
          spaceId: space.id,
          spaceName: space.name,
          targetId: tab.targetId,
          title: tab.title,
          url: contents && !destroyed ? contents.getURL() || tab.url : tab.url,
          activeTab: space.activeTabId === tab.targetId,
          ownership: space.ownership,
          lifecycle: space.lifecycle,
          runtime: Boolean(runtime),
          loaded: runtime?.loaded ?? false,
          retained: runtime?.retained ?? false,
          webContentsId: contents?.id ?? 0,
          osProcessId,
          frames,
          destroyed,
          presented: this.presentedTargetId === tab.targetId,
          backgroundSurface: this.hiddenSurfaceTargets.has(tab.targetId),
          primaryPreview: this.overviewScreencast?.targetId === tab.targetId,
          oneShotPreview: this.frameSubscriptionCaptures.has(tab.targetId),
          previewSuspended:
            this.overviewScreencastSuspendedTargets.has(tab.targetId),
        };
      }),
    );
    return {
      active: this.previewActive,
      activeAgentConnections: [...this.activeAgentConnections],
      backgroundSurfaceWindowVisible: this.options.captureWindow.isVisible(),
      presentedTargetId: this.presentedTargetId,
      presentationReservedTargetId: this.presentationReservedTargetId,
      pageViewport: { ...this.pageViewport },
      runtimes,
      visibleSpaceIds: [...this.visiblePreviewSpaceIds],
      captures: [...this.previewCaptures],
      coldCaptures: [...this.coldPreviewCaptures],
      parkedRestoreTargets: [...this.parkedRestoreTargets],
      qualityRetries: Object.fromEntries(this.previewQualityAttempts),
      frameSubscriptionCaptures: [...this.frameSubscriptionCaptures],
      phases: Object.fromEntries(this.previewPhases),
      errors: Object.fromEntries(this.previewErrors),
      dueAt: Object.fromEntries(this.previewDueAt),
      cache: [...this.previewCache.entries()].map(([targetId, entry]) => ({
        targetId,
        bytes: entry.data?.byteLength ?? 0,
        revision: entry.revision,
        capturedAt: entry.capturedAt,
        pending: Boolean(entry.pending),
      })),
      cacheBudget: {
        entries: this.previewCache.size,
        bytes: this.previewCacheBytes(),
        maxEntries: MAX_PREVIEW_CACHE_ENTRIES,
        maxBytes: MAX_PREVIEW_CACHE_BYTES,
        evictions: this.previewCacheEvictions,
      },
      publishedRevision: Object.fromEntries(this.publishedPreviewRevision),
      screencast: this.overviewScreencast
        ? {
            spaceId: this.overviewScreencast.spaceId,
            targetId: this.overviewScreencast.targetId,
            startedAt: this.overviewScreencast.startedAt,
            lastFrameAt: this.overviewScreencast.lastFrameAt,
            lastPublishedAt: this.overviewScreencast.lastPublishedAt,
            receivedFrames: this.overviewScreencast.receivedFrames,
            publishedFrames: this.overviewScreencast.publishedFrames,
            unchangedFrames: this.overviewScreencast.unchangedFrames,
            lastActivityAt: this.overviewScreencast.lastActivityAt,
            nextFrameDelayMs: this.overviewScreencast.nextFrameDelayMs,
          }
        : null,
      screencastSuspendedTargets: [
        ...this.overviewScreencastSuspendedTargets,
      ],
      surfaceGenerations: Object.fromEntries(this.surfaceGenerations),
    };
  }

  async prepareForPresentation(targetId: string) {
    this.presentationReservedTargetId = targetId;
    const generation = this.bumpSurfaceGeneration(targetId);
    await this.queueSurface(async () => {
      if (!this.isSurfaceGenerationCurrent(targetId, generation)) return;
      const view = this.getView(targetId);
      if (!view || !this.hiddenSurfaceTargets.has(targetId)) return;
      this.detachBackgroundSurfaceNow(targetId, view);
    });
  }

  cancelPresentationPreparation(targetId: string) {
    if (
      this.presentationReservedTargetId === targetId &&
      this.presentedTargetId !== targetId
    ) {
      this.presentationReservedTargetId = this.presentedTargetId;
      this.bumpSurfaceGeneration(targetId);
    }
  }

  private async releaseBackgroundSurface(targetId: string) {
    if (this.isPresentationSurface(targetId)) return;
    const generation = this.bumpSurfaceGeneration(targetId);
    await this.queueSurface(async () => {
      if (
        !this.isSurfaceGenerationCurrent(targetId, generation) ||
        this.isPresentationSurface(targetId)
      ) {
        return;
      }
      const view = this.getView(targetId);
      if (!view || !this.hiddenSurfaceTargets.has(targetId)) return;
      this.detachBackgroundSurfaceNow(targetId, view);
    });
  }

  async ensureBackgroundSurface(
    spaceId: number,
    targetId: string,
    waitForLoad = true,
  ) {
    if (this.isPresentationSurface(targetId)) return;
    const generation = this.bumpSurfaceGeneration(targetId);
    await this.queueSurface(async () => {
      if (
        !this.isSurfaceGenerationCurrent(targetId, generation) ||
        this.isPresentationSurface(targetId)
      ) {
        return;
      }
      const runtime = await this.ensureTabRuntimeStarted(spaceId, targetId);
      if (waitForLoad) await runtime.loading;
      if (
        !this.isSurfaceGenerationCurrent(targetId, generation) ||
        this.isPresentationSurface(targetId)
      ) {
        return;
      }
      const view = runtime.view;
      // Model a complete browser window even though only the page view is
      // rendered. The page surface intentionally keeps the complete browser
      // height and starts below Browser Chrome, matching the visible Ego
      // geometry used by foreground Spaces.
      // The visible App intentionally clips the lower chrome-height portion
      // of its full-height page surface to match Ego. The transparent capture
      // window has no human-visible chrome, so give it the extra native height
      // and keep the same page viewport fully contained. A clipped offscreen
      // child can otherwise make Viz repeatedly return a stale mailbox.
      const surface = {
        content: {
          x: 0,
          y: 0,
          width: this.pageViewport.width,
          height: this.pageViewport.height + BROWSER_CHROME_HEIGHT,
        },
        page: {
          x: 0,
          y: BROWSER_CHROME_HEIGHT,
          width: this.pageViewport.width,
          height: this.pageViewport.height,
        },
      };
      this.options.captureWindow.setBounds(surface.content);
      view.setBounds(surface.page);
      if (this.hiddenSurfaceTargets.has(targetId)) {
        // Input, snapshots and screenshots can all request the same already
        // attached background target. Reparenting it for every CDP command
        // interrupts Chromium's compositor and breaks multi-command gestures.
        this.options.captureWindow.showInactive();
        await this.primeAgentBackgroundVisibility(spaceId, targetId, view);
        return;
      }
      this.options.captureWindow.contentView.addChildView(view);
      this.hiddenSurfaceTargets.add(targetId);
      this.options.captureWindow.showInactive();
      if (waitForLoad) {
        await waitForViewport(view);
        // The DOM viewport can be available before Viz has committed the
        // first hit-test surface after native attachment. This one-time settle
        // keeps the first trusted click from being dropped on a cold Space.
        await delay(40);
      } else {
        await delay(40);
      }
      await this.primeAgentBackgroundVisibility(spaceId, targetId, view);
      if (
        !this.isSurfaceGenerationCurrent(targetId, generation) ||
        this.isPresentationSurface(targetId)
      ) {
        if (this.hiddenSurfaceTargets.has(targetId)) {
          this.detachBackgroundSurfaceNow(targetId, view);
        }
      }
    });
  }

  async parkAfterPresentation(targetId: string) {
    const space = this.findSpaceByTargetId(targetId);
    if (
      space?.ownership === "agent" &&
      space.lifecycle === "active" &&
      this.activeAgentConnections.has(space.id)
    ) {
      await this.ensureBackgroundSurface(space.id, targetId);
      return;
    }
    if (space) await this.releaseInactiveAgentSurfaces(space.id);
  }

  setAgentConnectionActive(spaceId: number, active: boolean) {
    if (active) {
      this.activeAgentConnections.add(spaceId);
      return;
    }
    if (!this.activeAgentConnections.delete(spaceId)) return;
    void this.releaseInactiveAgentSurfaces(spaceId).catch(() => undefined);
  }

  private async primeAgentBackgroundVisibility(
    spaceId: number,
    targetId: string,
    view: WebContentsView,
  ) {
    const space = this.getSpace(spaceId);
    const contents = view.webContents;
    if (
      this.backgroundVisibilityPrimedTargets.has(targetId) ||
      space?.ownership !== "agent" ||
      space.lifecycle !== "active" ||
      this.isPresentationSurface(targetId) ||
      contents.isDestroyed()
    ) {
      return;
    }
    try {
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
      // Chromium marks an opacity-zero, non-focusable native surface as
      // hidden when another application owns the foreground. A bounded
      // focus-emulation pulse activates the page lifecycle, and disabling it
      // immediately restores document.hasFocus() to false while visibility
      // remains visible — the same background state observed in Ego Lite.
      await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
        enabled: true,
      });
      await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
        enabled: false,
      });
      this.backgroundVisibilityPrimedTargets.add(targetId);
    } catch {
      // This is a compatibility enhancement. The real compositor surface and
      // trusted CDP input path remain usable if Chromium rejects the pulse.
    }
  }

  getActiveTab(spaceId: number) {
    const space = this.getSpaceOrThrow(spaceId);
    return space.tabs.find((tab) => tab.targetId === space.activeTabId)!;
  }

  getView(targetId: string) {
    return this.runtimes.get(targetId)?.view;
  }

  async navigate(spaceId: number, input: string) {
    const space = this.getSpaceOrThrow(spaceId);
    const tab = this.getActiveTab(spaceId);
    const view = await this.ensureTabRuntime(spaceId, tab.targetId);
    const url = normalizeNavigationUrl(input);
    const previousUrl = tab.url;
    try {
      await this.loadNavigation(view, url);
    } catch (error) {
      // Do not leave a typed-but-never-committed URL in persistent state.
      // Chromium may still expose a real failed-navigation URL; retain that
      // when available so the chrome matches the page the user sees.
      tab.url = logicalNavigationUrl(view.webContents.getURL(), previousUrl);
      tab.title = view.webContents.getTitle() || tab.title;
      space.updatedAt = Date.now();
      await this.persistAndNotify();
      throw error;
    }
    tab.url = logicalNavigationUrl(view.webContents.getURL(), url);
    tab.title = view.webContents.getTitle() || tab.title;
    space.updatedAt = Date.now();
    await this.persistAndNotify();
  }

  async goBack(spaceId: number) {
    const view = await this.activeView(spaceId);
    const history = view.webContents.navigationHistory;
    if (history.canGoBack()) await history.goBack();
  }

  async goForward(spaceId: number) {
    const view = await this.activeView(spaceId);
    const history = view.webContents.navigationHistory;
    if (history.canGoForward()) await history.goForward();
  }

  async reload(spaceId: number) {
    const view = await this.activeView(spaceId);
    view.webContents.reload();
  }

  navigationState(spaceId: number) {
    const space = this.getSpaceOrThrow(spaceId);
    const tab = this.getActiveTab(spaceId);
    const view = this.getView(tab.targetId);
    return {
      space: structuredClone(space),
      spaceCount: this.state.spaces.length,
      activeTab: structuredClone(tab),
      canGoBack: view?.webContents.navigationHistory.canGoBack() ?? false,
      canGoForward: view?.webContents.navigationHistory.canGoForward() ?? false,
      loading: view?.webContents.isLoading() ?? false,
    };
  }

  async setOwnership(
    spaceId: number,
    ownership: SpaceOwnership,
    lifecycle?: SpaceLifecycle,
  ) {
    await this.mutate(spaceId, async (space) => {
      space.ownership = ownership;
      if (lifecycle) space.lifecycle = lifecycle;
      space.updatedAt = Date.now();
    });
    if (ownership !== "agent") {
      for (const tab of this.getSpaceOrThrow(spaceId).tabs) {
        this.backgroundVisibilityPrimedTargets.delete(tab.targetId);
      }
      // User takeover, handoff, completion and error revoke the compositor
      // resource immediately. The socket may remain alive while its in-flight
      // command observes the generation failure, but it must not keep a
      // transparent GPU surface running after control has changed hands.
      this.setAgentConnectionActive(spaceId, false);
    }
    this.broadcastControl(spaceId);
  }

  async setLifecycle(spaceId: number, lifecycle: SpaceLifecycle) {
    const space = this.getSpaceOrThrow(spaceId);
    await this.setOwnership(spaceId, "user", lifecycle);
    space.agentTask = space.agentTask
      ? { ...space.agentTask, detail: lifecycle, updatedAt: Date.now() }
      : undefined;
    await this.persistAndNotify();
  }

  async setAgentTaskState(
    spaceId: number,
    state: Partial<NonNullable<SpaceRecord["agentTask"]>> | string,
  ) {
    const nextState =
      typeof state === "string" ? { detail: state } : state;
    await this.mutate(spaceId, async (space) => {
      space.agentTask = {
        title: nextState.title ?? space.agentTask?.title ?? space.name,
        detail: nextState.detail ?? space.agentTask?.detail ?? "Agent working",
        completed: nextState.completed ?? space.agentTask?.completed ?? 0,
        total: nextState.total ?? space.agentTask?.total ?? 1,
        updatedAt: Date.now(),
      };
    });
    this.noteOverviewActivity(this.getSpaceOrThrow(spaceId).activeTabId);
  }

  showAgentPointer(spaceId: number, x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const space = this.getSpace(spaceId);
    if (
      !space ||
      space.ownership !== "agent" ||
      space.lifecycle !== "active"
    ) {
      return;
    }
    const pointer = {
      x: Math.max(0, x),
      y: Math.max(0, y),
      label: "正在浏览网页",
    };
    for (const listener of this.agentPointerListeners) {
      listener(spaceId, pointer);
    }
    this.noteOverviewActivity(space.activeTabId);
  }

  noteOverviewActivity(targetId: string) {
    const state = this.overviewScreencast;
    if (!state || state.targetId !== targetId) return;
    state.lastActivityAt = Date.now();
    state.unchangedFrames = 0;
    if (state.resubscribeTimer) clearTimeout(state.resubscribeTimer);
    state.resubscribeTimer = undefined;
    if (!state.subscriptionActive) this.scheduleNextOverviewFrame(state, 0);
  }

  async capturePreview(spaceId: number, bounds: Rectangle): Promise<Buffer> {
    const tab = this.getActiveTab(spaceId);
    const cached = this.previewCache.get(tab.targetId);
    if (cached?.data && Date.now() - cached.capturedAt < 450) {
      return cached.data;
    }
    if (cached?.pending) return cached.pending;

    const pending: Promise<Buffer> = this.capturePreviewNow(
      spaceId,
      tab.targetId,
      bounds,
    );
    this.setPreviewCacheEntry(tab.targetId, {
      data: cached?.data,
      capturedAt: cached?.capturedAt ?? 0,
      revision: cached?.revision ?? 0,
      pending,
    });
    try {
      const data = await pending;
      if (cached?.data && cached.data.equals(data)) {
        this.setPreviewCacheEntry(tab.targetId, {
          data: cached.data,
          capturedAt: Date.now(),
          revision: cached.revision,
        });
        return cached.data;
      }
      this.setPreviewCacheEntry(tab.targetId, {
        data,
        capturedAt: Date.now(),
        revision: ++this.previewRevision,
      });
      return data;
    } catch (error) {
      if (cached?.data) {
        this.setPreviewCacheEntry(tab.targetId, {
          data: cached.data,
          capturedAt: cached.capturedAt,
          revision: cached.revision,
        });
        return cached.data;
      }
      this.previewCache.delete(tab.targetId);
      throw error;
    }
  }

  private async capturePreviewNow(
    spaceId: number,
    targetId: string,
    bounds: Rectangle,
  ): Promise<Buffer> {
    const tab = this.getActiveTab(spaceId);
    if (tab.targetId !== targetId) {
      return this.capturePreview(spaceId, bounds);
    }
    const coldStart = !this.runtimes.has(tab.targetId);
    this.previewPhases.set(spaceId, "starting-runtime");
    const runtime = await withTimeout(
      this.ensureTabRuntimeStarted(spaceId, tab.targetId),
      1200,
      "preview runtime",
    );
    if (!this.previewActive) {
      throw new Error("overview preview is no longer active");
    }
    const view = runtime.view;
    const alreadyBackground = this.hiddenSurfaceTargets.has(tab.targetId);
    const pausedOverview = this.pauseOverviewFrameCapture();
    try {
      if (this.presentedTargetId !== tab.targetId) {
        this.previewPhases.set(spaceId, "attaching-surface");
        await withTimeout(
          this.ensureBackgroundSurface(spaceId, tab.targetId, false),
          1200,
          "preview surface",
        );
        // Try the first cold capture early enough that fast pages are visible
        // promptly. If Chromium has committed DOM but Viz still returns a
        // near-solid first frame, the bounded quality retry below waits for a
        // meaningful compositor frame instead of publishing white pixels.
        if (coldStart) {
          if (isInternalNewTabUrl(tab.url)) {
            // A legacy persisted local New Tab is migrated to Google by the
            // loader. Keep a short first attempt before the remote retry path.
            await Promise.all([
              Promise.race([runtime.loading, delay(240)]),
              delay(80),
            ]);
          } else {
            await Promise.all([
              Promise.race([runtime.loading, delay(1100)]),
              delay(520),
            ]);
          }
        } else if (!runtime.loaded) {
          await Promise.race([runtime.loading, delay(600)]);
        } else {
          await Promise.race([runtime.loading, delay(180)]);
        }
      }
      if (!this.previewActive) {
        throw new Error("overview preview is no longer active");
      }
      if (coldStart && this.options.forceColdPreviewCaptureFailure) {
        throw new Error("forced cold preview capture failure");
      }
      const capture = async () => {
        if (coldStart) {
          try {
            return await this.captureCdpPreview(spaceId, view, bounds, 700);
          } catch {
            return this.captureNativePreview(spaceId, view, bounds, 700);
          }
        }
        try {
          return await this.captureCdpPreview(spaceId, view, bounds);
        } catch {
          try {
            return await this.capturePresentedPreview(
              spaceId,
              targetId,
              view,
              bounds,
            );
          } catch {
            return this.captureNativePreview(spaceId, view, bounds);
          }
        }
      };
      return await capture();
    } finally {
      const space = this.getSpace(spaceId);
      const liveAgentSurface =
        space?.ownership === "agent" &&
        this.activeAgentConnections.has(spaceId);
      if (
        this.presentedTargetId !== tab.targetId &&
        !alreadyBackground &&
        !liveAgentSurface
      ) {
        await this.releaseBackgroundSurface(tab.targetId);
      }
      this.resumeOverviewFrameCapture(pausedOverview);
    }
  }

  private async captureCdpPreview(
    spaceId: number,
    view: WebContentsView,
    bounds: Rectangle,
    timeoutMs = 900,
  ) {
    const contents = view.webContents;
    this.previewPhases.set(spaceId, "capturing-cdp-frame");
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    const result = await withTimeout(
      contents.debugger.sendCommand("Page.captureScreenshot", {
        format: "jpeg",
        quality: 62,
        fromSurface: true,
        captureBeyondViewport: false,
      }),
      timeoutMs,
      "cdp preview screenshot",
    );
    const encoded = typeof result?.data === "string" ? result.data : "";
    if (!encoded) throw new Error("cdp preview screenshot is empty");
    const image = nativeImage.createFromBuffer(Buffer.from(encoded, "base64"));
    if (image.isEmpty()) throw new Error("cdp preview image is empty");
    const currentSize = image.getSize();
    const targetWidth = Math.max(1, Math.min(bounds.width, currentSize.width));
    const resized =
      currentSize.width > targetWidth
        ? image.resize({ width: targetWidth, quality: "good" })
        : image;
    this.previewPhases.set(spaceId, "captured-cdp-frame");
    return resized.toJPEG(62);
  }

  private async capturePresentedPreview(
    spaceId: number,
    targetId: string,
    view: WebContentsView,
    bounds: Rectangle,
    timeoutMs = 900,
  ) {
    const contents = view.webContents;
    this.frameSubscriptionCaptures.add(targetId);
    this.previewPhases.set(spaceId, "waiting-for-presented-frame");
    let stop = () => undefined;
    try {
      const image = await withTimeout(
        new Promise<NativeImage>((resolve, reject) => {
          let stopped = false;
          const onDestroyed = () => {
            stop();
            reject(new Error("preview renderer was destroyed"));
          };
          stop = () => {
            if (stopped) return;
            stopped = true;
            contents.off("destroyed", onDestroyed);
            if (contents.isDestroyed()) return;
            try {
              contents.endFrameSubscription();
            } catch {
              // A renderer teardown can end the subscription first.
            }
          };
          contents.once("destroyed", onDestroyed);
          try {
            contents.beginFrameSubscription(false, (frame) => {
              if (frame.isEmpty()) return;
              stop();
              resolve(frame);
            });
            contents.invalidate();
          } catch (error) {
            stop();
            reject(error);
          }
        }),
        timeoutMs,
        "presented preview frame",
      );
      if (image.isEmpty()) throw new Error("presented preview frame is empty");
      const currentSize = image.getSize();
      const targetWidth = Math.max(1, Math.min(bounds.width, currentSize.width));
      const resized =
        currentSize.width > targetWidth
          ? image.resize({ width: targetWidth, quality: "good" })
          : image;
      this.previewPhases.set(spaceId, "captured-presented-frame");
      return resized.toJPEG(62);
    } finally {
      stop();
      this.frameSubscriptionCaptures.delete(targetId);
      this.requestOverviewScreencastReconcile();
    }
  }

  private async captureNativePreview(
    spaceId: number,
    view: WebContentsView,
    bounds: Rectangle,
    timeoutMs = 900,
  ) {
    this.previewPhases.set(spaceId, "capturing-native-fallback");
    const image = await withTimeout(
      view.webContents.capturePage(),
      timeoutMs,
      "native preview screenshot",
    );
    if (image.isEmpty()) throw new Error("native preview screenshot is empty");
    const currentSize = image.getSize();
    const targetWidth = Math.max(1, Math.min(bounds.width, currentSize.width));
    const resized =
      currentSize.width > targetWidth
        ? image.resize({ width: targetWidth, quality: "good" })
        : image;
    this.previewPhases.set(spaceId, "captured-native-fallback");
    return resized.toJPEG(62);
  }

  private previewHasVisualDetail(data: Buffer) {
    const image = nativeImage.createFromBuffer(data);
    if (image.isEmpty()) return false;
    const size = image.getSize();
    return bitmapHasVisualDetail(image.toBitmap(), size.width, size.height);
  }

  private async pageHasVisualContent(view: WebContentsView) {
    try {
      return Boolean(
        await withTimeout(
          view.webContents.executeJavaScript(
            `(() => {
              const body = document.body;
              if (!body) return false;
              if ((body.innerText || '').trim().length > 0) return true;
              return Boolean(body.querySelector('img, svg, canvas, video, iframe, input, button, textarea, select'));
            })()`,
            false,
          ),
          120,
          "preview content probe",
        ),
      );
    } catch {
      return false;
    }
  }

  private cachedPreviewForSpace(spaceId: number) {
    const space = this.getSpace(spaceId);
    if (!space) return undefined;
    return this.previewCache.get(space.activeTabId);
  }

  private previewHydrationPriority(spaceId: number) {
    const tab = this.getActiveTab(spaceId);
    try {
      const protocol = new URL(tab.url).protocol;
      if (["x-browser:", "file:", "data:", "about:"].includes(protocol)) {
        return 0;
      }
    } catch {
      return 0;
    }
    return this.getSpace(spaceId)?.ownership === "user" ? 1 : 2;
  }

  private schedulePreviewPump(delayMs: number) {
    if (!this.previewActive || this.visiblePreviewSpaceIds.size === 0) return;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = undefined;
      void this.pumpVisiblePreviews().catch(() => undefined);
    }, Math.max(0, delayMs));
  }

  private async pumpVisiblePreviews() {
    if (!this.previewActive) return;
    const now = Date.now();
    const live = this.overviewScreencast;
    const liveHealthy = Boolean(
      live &&
        (live.lastFrameAt > 0
          ? now - live.lastFrameAt < 2500
          : now - live.startedAt < 1800),
    );
    const liveSpaceId = liveHealthy ? live?.spaceId : undefined;
    const candidates = [...this.visiblePreviewSpaceIds]
      .filter((id) => id !== liveSpaceId)
      .filter((id) => {
        const targetId = this.getSpace(id)?.activeTabId;
        return Boolean(
          targetId &&
            !this.overviewScreencastSuspendedTargets.has(targetId),
        );
      })
      .filter((id) => !this.previewCaptures.has(id))
      .filter((id) => (this.previewDueAt.get(id) ?? 0) <= now)
      .map((id) => {
        const targetId = this.getSpace(id)!.activeTabId;
        const warm = this.runtimes.get(targetId)?.loaded === true;
        return {
          id,
          warm,
          priority: warm ? -1 : this.previewHydrationPriority(id),
        };
      })
      .sort((left, right) => left.priority - right.priority);
    // Warm captures remain two-wide, while only one cold renderer may be
    // hydrated at a time. This restores visible thumbnails after restart
    // without waking every persisted Space simultaneously.
    const captureLimit = 2;
    const slots = Math.max(0, captureLimit - this.previewCaptures.size);
    const coldSlots = Math.max(0, 1 - this.coldPreviewCaptures.size);
    const due = selectPreviewCaptureIds(candidates, slots, coldSlots);

    if (due.length === 0) {
      const nextAt = Math.min(
        ...[...this.visiblePreviewSpaceIds]
          .filter((id) => !this.previewCaptures.has(id))
          .map((id) => this.previewDueAt.get(id) ?? now + 500),
      );
      if (Number.isFinite(nextAt)) this.schedulePreviewPump(Math.max(40, nextAt - now));
      return;
    }

    await Promise.allSettled(due.map((id) => this.captureAndPublishPreview(id)));
    this.schedulePreviewPump(0);
  }

  private async captureAndPublishPreview(spaceId: number) {
    const initialTargetId = this.getSpace(spaceId)?.activeTabId;
    const initialRuntime = initialTargetId
      ? this.runtimes.get(initialTargetId)
      : undefined;
    const cold = !initialRuntime?.loaded;
    const qualityAttempt = this.previewQualityAttempts.get(spaceId) ?? 0;
    const coldSequence = cold || qualityAttempt > 0;
    const runtimesBeforeCapture = new Set(this.runtimes.keys());
    let keepRuntimeForRetry = false;
    let captureSucceeded = false;
    this.previewCaptures.add(spaceId);
    if (cold) this.coldPreviewCaptures.add(spaceId);
    this.previewErrors.delete(spaceId);
    try {
      const data = await this.capturePreview(spaceId, {
        x: 0,
        y: 0,
        width: 520,
        height: 330,
      });
      const retryView = initialTargetId ? this.getView(initialTargetId) : undefined;
      const needsQualityRetry = Boolean(
        coldSequence &&
          initialTargetId &&
          retryView &&
          qualityAttempt < 2 &&
          !this.previewHasVisualDetail(data) &&
          await this.pageHasVisualContent(retryView),
      );
      if (needsQualityRetry && initialTargetId) {
        keepRuntimeForRetry = true;
        this.previewQualityAttempts.set(spaceId, qualityAttempt + 1);
        this.previewQualityRetryTargets.set(spaceId, initialTargetId);
        // Do not let capturePreview's short freshness cache return the same
        // flat frame on the warm retry.
        this.previewCache.delete(initialTargetId);
        this.previewDueAt.set(
          spaceId,
          Date.now() + (qualityAttempt === 0 ? 180 : 360),
        );
        return;
      }
      this.previewQualityAttempts.delete(spaceId);
      this.previewQualityRetryTargets.delete(spaceId);
      captureSucceeded = true;
      const cached = this.cachedPreviewForSpace(spaceId);
      if (
        cached?.data &&
        this.previewActive &&
        this.visiblePreviewSpaceIds.has(spaceId) &&
        cached.revision > (this.publishedPreviewRevision.get(spaceId) ?? -1)
      ) {
        this.options.publishPreviewFrame({
          spaceId,
          revision: cached.revision,
          data,
        });
        this.publishedPreviewRevision.set(spaceId, cached.revision);
      }
      const space = this.getSpace(spaceId);
      const controlled =
        space?.ownership === "agent" && space.lifecycle === "active";
      this.previewDueAt.set(
        spaceId,
        coldSequence
          ? Number.POSITIVE_INFINITY
          : controlled
            ? Date.now() + 850
            : Number.POSITIVE_INFINITY,
      );
    } catch (error) {
      this.previewErrors.set(spaceId, String(error));
      const retryRuntime = initialTargetId
        ? this.runtimes.get(initialTargetId)
        : undefined;
      const retrySpace = this.getSpace(spaceId);
      const retryTab = retrySpace?.tabs.find(
        (tab) => tab.targetId === initialTargetId,
      );
      const shouldKeepLoadingRuntime = Boolean(
        coldSequence &&
          initialTargetId &&
          retryRuntime &&
          !retryRuntime.view.webContents.isDestroyed() &&
          retryTab &&
          isRemoteWebUrl(retryTab.url) &&
          qualityAttempt < MAX_PREVIEW_RECOVERY_ATTEMPTS &&
          this.previewActive &&
          this.visiblePreviewSpaceIds.has(spaceId),
      );
      if (shouldKeepLoadingRuntime && initialTargetId) {
        // Imported Profiles can need more than the first bounded capture
        // window to restore Chromium storage and commit a Viz frame. Keep the
        // same renderer loading for a warm retry; destroying it here restarts
        // profile/page initialization forever and leaves only placeholders.
        keepRuntimeForRetry = true;
        this.previewQualityAttempts.set(spaceId, qualityAttempt + 1);
        this.previewQualityRetryTargets.set(spaceId, initialTargetId);
        this.previewCache.delete(initialTargetId);
        this.previewDueAt.set(
          spaceId,
          Date.now() + (retryRuntime?.loaded ? 180 : 420),
        );
      } else {
        this.previewQualityAttempts.delete(spaceId);
        this.previewQualityRetryTargets.delete(spaceId);
        this.previewDueAt.set(
          spaceId,
          Date.now() + (coldSequence ? 1600 : 3000),
        );
      }
    } finally {
      const liveCandidateTarget = (() => {
        const space = this.getSpace(spaceId);
        if (
          !initialTargetId ||
          !this.previewActive ||
          !this.visiblePreviewSpaceIds.has(spaceId) ||
          space?.ownership !== "agent" ||
          space.lifecycle !== "active"
        ) {
          return undefined;
        }
        return initialTargetId;
      })();
      const spaceTargetIds = new Set(
        this.getSpace(spaceId)?.tabs.map((tab) => tab.targetId) ?? [],
      );
      const previewOnlyTargets = [...this.runtimes.keys()].filter(
        (targetId) =>
          spaceTargetIds.has(targetId) && !runtimesBeforeCapture.has(targetId),
      );
      const parkRestoredTarget = Boolean(
        captureSucceeded &&
          initialTargetId &&
          this.parkRestoredPreviewRuntime(spaceId, initialTargetId),
      );
      if (!keepRuntimeForRetry) {
        const cleanupTargets = new Set(previewOnlyTargets);
        if (coldSequence && initialTargetId) cleanupTargets.add(initialTargetId);
        if (liveCandidateTarget) cleanupTargets.delete(liveCandidateTarget);
        if (parkRestoredTarget && initialTargetId) {
          cleanupTargets.delete(initialTargetId);
        }
        for (const targetId of cleanupTargets) {
          await this.releasePreviewOnlyRuntime(targetId);
        }
      }
      this.previewCaptures.delete(spaceId);
      this.coldPreviewCaptures.delete(spaceId);
      this.previewPhases.delete(spaceId);
      await this.requestOverviewScreencastReconcile();
      if (
        liveCandidateTarget &&
        !keepRuntimeForRetry &&
        this.overviewScreencast?.targetId !== liveCandidateTarget
      ) {
        await this.releasePreviewOnlyRuntime(liveCandidateTarget);
      }
    }
  }

  private parkRestoredPreviewRuntime(spaceId: number, targetId: string) {
    const runtime = this.runtimes.get(targetId);
    const space = this.getSpace(spaceId);
    const tab = space?.tabs.find((candidate) => candidate.targetId === targetId);
    if (
      !runtime ||
      runtime.retained ||
      !space ||
      space.activeTabId !== targetId ||
      !this.previewActive ||
      !this.visiblePreviewSpaceIds.has(spaceId) ||
      !tab ||
      (!isRemoteWebUrl(tab.url) && !isInternalNewTabUrl(tab.url))
    ) {
      return false;
    }
    for (const parkedTarget of this.parkedRestoreTargets) {
      const parkedRuntime = this.runtimes.get(parkedTarget);
      if (!parkedRuntime || parkedRuntime.retained) {
        this.parkedRestoreTargets.delete(parkedTarget);
      }
    }
    if (
      !this.parkedRestoreTargets.has(targetId) &&
      this.parkedRestoreTargets.size >= MAX_PARKED_RESTORE_RUNTIMES
    ) {
      return false;
    }
    this.parkedRestoreTargets.add(targetId);
    return true;
  }

  private newTabRecord(url: string): TabRecord {
    return {
      targetId: randomUUID(),
      url,
      title: "New Tab",
      createdAt: Date.now(),
    };
  }

  private bindTabRuntime(spaceId: number, targetId: string, runtime: TabRuntime) {
    const contents = runtime.view.webContents;
    const update = async () => {
      const space = this.getSpace(spaceId);
      const tab = space?.tabs.find((candidate) => candidate.targetId === targetId);
      if (!space || !tab || contents.isDestroyed()) return;
      tab.url = logicalNavigationUrl(contents.getURL(), tab.url);
      tab.title = contents.getTitle() || tab.title;
      space.updatedAt = Date.now();
      await this.persistAndNotify();
    };
    const invalidatePreview = () => {
      this.previewCache.delete(targetId);
      if (this.visiblePreviewSpaceIds.has(spaceId)) {
        this.previewDueAt.set(spaceId, 0);
        this.schedulePreviewPump(0);
        this.requestOverviewScreencastReconcile();
      }
    };
    const updateSafely = () => {
      void update().catch(() => undefined);
    };
    contents.on("did-navigate", () => {
      invalidatePreview();
      updateSafely();
    });
    contents.on("did-navigate-in-page", () => {
      invalidatePreview();
      updateSafely();
    });
    contents.on("page-title-updated", updateSafely);
    contents.on("did-start-loading", () => {
      invalidatePreview();
      this.notify();
    });
    contents.on("dom-ready", () => {
      // Re-publish control after every document preload has installed its IPC
      // listener. This closes the navigation-time window where an opaque or
      // very fast document could miss the initial invoke before first paint.
      this.broadcastControl(spaceId);
    });
    contents.on("did-stop-loading", () => {
      runtime.loaded = true;
      invalidatePreview();
      this.notify();
    });
    contents.once("destroyed", () => {
      if (runtime.nativePopup) {
        this.removeDestroyedNativePopup(spaceId, targetId);
      }
      this.requestOverviewScreencastReconcile();
    });
    contents.setWindowOpenHandler((details) => {
      const reusable = this.reusableNativePopup(spaceId, details.frameName);
      if (reusable) {
        this.activateNativeTab(spaceId, reusable.targetId);
      }
      return {
        action: "allow",
        createWindow: (options) => {
          if (reusable && !reusable.runtime.view.webContents.isDestroyed()) {
            return reusable.runtime.view.webContents;
          }
          return this.createNativePopup(
            spaceId,
            targetId,
            details.url,
            details.frameName,
            options,
          );
        },
      };
    });
  }

  private reusableNativePopup(spaceId: number, frameName: string) {
    if (!frameName || frameName === "_blank" || frameName.startsWith("_")) {
      return undefined;
    }
    const space = this.getSpace(spaceId);
    if (!space) return undefined;
    for (const tab of space.tabs) {
      const runtime = this.runtimes.get(tab.targetId);
      if (
        runtime?.nativePopup &&
        runtime.frameName === frameName &&
        !runtime.view.webContents.isDestroyed()
      ) {
        return { targetId: tab.targetId, runtime };
      }
    }
    return undefined;
  }

  private createNativePopup(
    spaceId: number,
    openerTargetId: string,
    url: string,
    frameName: string,
    options: BrowserWindowConstructorOptions,
  ) {
    const space = this.getSpaceOrThrow(spaceId);
    // Electron supplies the fully merged constructor options for the native
    // child. Passing that object directly to WebContentsView preserves the
    // Chromium opener, WindowProxy and named browsing-context relationship.
    const view = new ElectronWebContentsView(options);
    view.setBackgroundColor("#ffffff");
    const tab = this.newTabRecord(url || "about:blank");
    const runtime: TabRuntime = {
      view,
      loaded: false,
      loading: Promise.resolve(),
      retained: true,
      nativePopup: true,
      frameName,
    };
    this.runtimes.set(tab.targetId, runtime);
    this.bindTabRuntime(spaceId, tab.targetId, runtime);
    space.tabs.push(tab);
    space.activeTabId = tab.targetId;
    space.updatedAt = Date.now();
    this.notify();
    void this.options.store.save(this.state).catch(() => undefined);
    void this.emitActiveTabChanged(spaceId, tab.targetId);

    if (this.presentedTargetId !== openerTargetId) {
      void this.ensureBackgroundSurface(spaceId, tab.targetId, false).catch(
        () => undefined,
      );
    }
    return view.webContents;
  }

  private activateNativeTab(spaceId: number, targetId: string) {
    const space = this.getSpace(spaceId);
    if (!space || space.activeTabId === targetId) return;
    if (!space.tabs.some((tab) => tab.targetId === targetId)) return;
    space.activeTabId = targetId;
    space.updatedAt = Date.now();
    this.notify();
    void this.options.store.save(this.state).catch(() => undefined);
    void this.emitActiveTabChanged(spaceId, targetId);
  }

  private removeDestroyedNativePopup(spaceId: number, targetId: string) {
    const space = this.getSpace(spaceId);
    if (!space) return;
    const index = space.tabs.findIndex((tab) => tab.targetId === targetId);
    if (index < 0) return;
    const wasActive = space.activeTabId === targetId;
    space.tabs.splice(index, 1);
    const runtime = this.runtimes.get(targetId);
    if (runtime) this.detachBackgroundSurfaceNow(targetId, runtime.view);
    this.runtimes.delete(targetId);
    this.foregroundCadenceReasons.delete(targetId);
    this.backgroundVisibilityPrimedTargets.delete(targetId);
    this.surfaceGenerations.delete(targetId);
    this.previewCache.delete(targetId);
    if (space.tabs.length === 0) {
      space.tabs.push(this.newTabRecord(X_BROWSER_DEFAULT_NEW_TAB_URL));
    }
    if (wasActive) {
      space.activeTabId = space.tabs[Math.max(0, index - 1)].targetId;
    }
    space.updatedAt = Date.now();
    this.notify();
    void this.options.store.save(this.state).catch(() => undefined);
    if (wasActive) void this.emitActiveTabChanged(spaceId, space.activeTabId);
  }

  private async emitActiveTabChanged(spaceId: number, targetId: string) {
    await Promise.all(
      [...this.activeTabListeners].map((listener) =>
        Promise.resolve(listener(spaceId, targetId)),
      ),
    );
  }

  private async loadTab(runtime: TabRuntime, url: string) {
    try {
      await this.loadNavigation(runtime.view, url);
    } catch {
      // Chromium owns the navigation error page. Do not replace a failed real
      // Google load with a local imitation or let startup reject globally.
    }
    runtime.loaded = true;
  }

  private async loadNavigation(view: WebContentsView, url: string) {
    if (isInternalNewTabUrl(url)) {
      await view.webContents.loadURL(X_BROWSER_DEFAULT_NEW_TAB_URL);
      return;
    }
    await view.webContents.loadURL(url);
  }

  private destroyRuntime(targetId: string) {
    const runtime = this.runtimes.get(targetId);
    if (runtime) this.detachBackgroundSurfaceNow(targetId, runtime.view);
    else {
      this.hiddenSurfaceTargets.delete(targetId);
      this.backgroundVisibilityPrimedTargets.delete(targetId);
      this.hideCaptureWindowIfIdle();
    }
    this.runtimes.delete(targetId);
    this.parkedRestoreTargets.delete(targetId);
    this.foregroundCadenceReasons.delete(targetId);
    this.backgroundVisibilityPrimedTargets.delete(targetId);
    this.surfaceGenerations.delete(targetId);
    if (this.presentationReservedTargetId === targetId) {
      this.presentationReservedTargetId = null;
    }
    this.previewCache.delete(targetId);
    const space = this.findSpaceByTargetId(targetId);
    if (space) this.previewDueAt.delete(space.id);
    if (runtime && !runtime.view.webContents.isDestroyed()) {
      runtime.view.webContents.close();
    }
    this.requestOverviewScreencastReconcile();
  }

  private detachBackgroundSurfaceNow(
    targetId: string,
    view: WebContentsView,
  ) {
    const root = this.options.captureWindow.contentView;
    if (root.children.includes(view)) {
      try {
        root.removeChildView(view);
      } catch {
        // A concurrent renderer teardown may already have detached the view.
      }
    }
    this.hiddenSurfaceTargets.delete(targetId);
    this.backgroundVisibilityPrimedTargets.delete(targetId);
    this.hideCaptureWindowIfIdle();
  }

  private hideCaptureWindowIfIdle() {
    if (
      this.hiddenSurfaceTargets.size > 0 &&
      this.options.captureWindow.contentView.children.length > 0
    ) {
      return;
    }
    this.options.captureWindow.hide();
  }

  private async releasePreviewOnlyRuntime(targetId: string) {
    let runtime = this.runtimes.get(targetId);
    if (
      !runtime ||
      runtime.retained ||
      this.parkedRestoreTargets.has(targetId) ||
      this.isPresentationSurface(targetId) ||
      this.frameSubscriptionCaptures.has(targetId) ||
      this.overviewScreencast?.targetId === targetId
    ) {
      if (!runtime || runtime.retained) {
        this.parkedRestoreTargets.delete(targetId);
      }
      return;
    }
    await this.releaseBackgroundSurface(targetId);
    runtime = this.runtimes.get(targetId);
    if (
      !runtime ||
      runtime.retained ||
      this.parkedRestoreTargets.has(targetId) ||
      this.isPresentationSurface(targetId) ||
      this.hiddenSurfaceTargets.has(targetId) ||
      this.frameSubscriptionCaptures.has(targetId) ||
      this.overviewScreencast?.targetId === targetId
    ) {
      return;
    }
    // Let Viz retire the captured mailbox after the view is detached before
    // destroying its renderer. Immediate close can race the final JPEG readback
    // and produces SharedImage "non-existent mailbox" errors on macOS.
    await delay(120);
    runtime = this.runtimes.get(targetId);
    if (
      !runtime ||
      runtime.retained ||
      this.parkedRestoreTargets.has(targetId) ||
      this.isPresentationSurface(targetId) ||
      this.hiddenSurfaceTargets.has(targetId) ||
      this.frameSubscriptionCaptures.has(targetId) ||
      this.overviewScreencast?.targetId === targetId
    ) {
      return;
    }
    this.runtimes.delete(targetId);
    this.parkedRestoreTargets.delete(targetId);
    this.foregroundCadenceReasons.delete(targetId);
    this.surfaceGenerations.delete(targetId);
    if (!runtime.view.webContents.isDestroyed()) {
      runtime.view.webContents.close();
    }
    this.requestOverviewScreencastReconcile();
  }

  private requestOverviewScreencastReconcile() {
    const generation = ++this.overviewScreencastGeneration;
    this.overviewScreencastQueue = this.overviewScreencastQueue
      .then(() => this.reconcileOverviewScreencast(generation))
      .catch((error) => {
        const desired = this.desiredOverviewScreencast();
        if (desired) {
          this.previewErrors.set(desired.spaceId, String(error));
          this.overviewScreencastRetryAt.set(
            desired.targetId,
            Date.now() + 4000,
          );
          this.schedulePreviewRecovery(desired.spaceId, 1200);
          this.schedulePreviewPump(0);
        }
      });
    return this.overviewScreencastQueue;
  }

  private desiredOverviewScreencast() {
    if (!this.previewActive) return undefined;
    const now = Date.now();
    const candidates: Array<{
      spaceId: number;
      targetId: string;
      controlled: boolean;
      activityAt: number;
    }> = [];
    for (const spaceId of this.visiblePreviewSpaceIds) {
      const space = this.getSpace(spaceId);
      if (!space) continue;
      const controlled =
        space.ownership === "agent" && space.lifecycle === "active";
      // User-owned Spaces use cached, event-driven thumbnails. Keeping a
      // hidden real page foregrounded for a decorative live card makes CSS
      // animations and WebGL consume the same GPU budget as another visible
      // browser window. Agent-controlled Spaces remain live so active
      // automation is still observable from Overview.
      if (!controlled) continue;
      const targetId = space.activeTabId;
      if (!this.runtimes.has(targetId)) continue;
      if (this.coldPreviewCaptures.has(spaceId)) continue;
      if (this.overviewScreencastSuspendedTargets.has(targetId)) continue;
      if ((this.overviewScreencastRetryAt.get(targetId) ?? 0) > now) continue;
      candidates.push({
        spaceId,
        targetId,
        controlled,
        activityAt: space.agentTask?.updatedAt ?? space.updatedAt,
      });
    }
    candidates.sort((left, right) => {
      if (left.controlled !== right.controlled) return left.controlled ? -1 : 1;
      const leftWarm = this.runtimes.has(left.targetId);
      const rightWarm = this.runtimes.has(right.targetId);
      if (leftWarm !== rightWarm) return leftWarm ? -1 : 1;
      return right.activityAt - left.activityAt;
    });
    return candidates[0];
  }

  private async reconcileOverviewScreencast(generation: number) {
    const desired = this.desiredOverviewScreencast();
    const active = this.overviewScreencast;
    if (
      active &&
      desired?.spaceId === active.spaceId &&
      desired.targetId === active.targetId
    ) {
      return;
    }
    if (active) await this.stopOverviewScreencast(active);
    if (generation !== this.overviewScreencastGeneration) return;
    const current = this.desiredOverviewScreencast();
    if (!current) return;
    await this.startOverviewScreencast(current.spaceId, current.targetId, generation);
  }

  private async startOverviewScreencast(
    spaceId: number,
    targetId: string,
    generation: number,
  ) {
    for (let attempt = 0; attempt < 24; attempt++) {
      if (!this.frameSubscriptionCaptures.has(targetId)) break;
      await delay(40);
    }
    if (this.frameSubscriptionCaptures.has(targetId)) {
      throw new Error("preview frame subscription is still busy");
    }
    const runtime = await withTimeout(
      this.ensureTabRuntimeStarted(spaceId, targetId),
      1200,
      "overview screencast runtime",
    );
    if (generation !== this.overviewScreencastGeneration) return;
    await withTimeout(
      this.ensureBackgroundSurface(spaceId, targetId, false),
      1200,
      "overview screencast surface",
    );
    if (
      generation !== this.overviewScreencastGeneration ||
      this.desiredOverviewScreencast()?.targetId !== targetId
    ) {
      const space = this.getSpace(spaceId);
      if (space?.ownership !== "agent") {
        await this.releaseBackgroundSurface(targetId);
      }
      return;
    }
    const contents = runtime.view.webContents;
    const state: OverviewScreencastState = {
      spaceId,
      targetId,
      contentsId: contents.id,
      generation,
      listener: () => undefined,
      subscriptionActive: false,
      startedAt: Date.now(),
      lastFrameAt: 0,
      lastPublishedAt: 0,
      receivedFrames: 0,
      publishedFrames: 0,
      unchangedFrames: 0,
      lastActivityAt: Date.now(),
      nextFrameDelayMs: 0,
    };
    state.listener = (image) => {
      if (this.overviewScreencast !== state || image.isEmpty()) return;
      this.endOverviewFrameSubscription(state);
      state.receivedFrames += 1;
      state.lastFrameAt = Date.now();
      try {
        const changed = this.publishOverviewScreencastFrame(state, image);
        state.unchangedFrames = changed ? 0 : state.unchangedFrames + 1;
        this.previewErrors.delete(state.spaceId);
      } catch (error) {
        this.previewErrors.set(state.spaceId, String(error));
      } finally {
        this.scheduleNextOverviewFrame(
          state,
          overviewPreviewDelay({
            unchangedFrames: state.unchangedFrames,
            millisecondsSinceActivity: Date.now() - state.lastActivityAt,
          }),
        );
      }
    };
    this.overviewScreencast = state;
    this.setPageForegroundCadence(targetId, "overview-live-preview", true);
    try {
      this.subscribeOverviewFrame(state);
      this.overviewScreencastRetryAt.delete(targetId);
      this.previewPhases.set(spaceId, "streaming");
    } catch (error) {
      await this.stopOverviewScreencast(state);
      throw error;
    }
  }

  private subscribeOverviewFrame(state: OverviewScreencastState) {
    if (
      this.overviewScreencast !== state ||
      state.subscriptionActive ||
      !this.previewActive
    ) {
      return;
    }
    if (
      this.previewCaptures.size > 0 ||
      this.frameSubscriptionCaptures.size > 0 ||
      this.overviewFramePauseDepth > 0
    ) {
      this.scheduleNextOverviewFrame(state, 80);
      return;
    }
    const contents = this.getView(state.targetId)?.webContents;
    if (!contents || contents.isDestroyed()) return;
    try {
      state.subscriptionActive = true;
      contents.beginFrameSubscription(false, state.listener);
      contents.invalidate();
      state.frameTimeout = setTimeout(() => {
        state.frameTimeout = undefined;
        this.endOverviewFrameSubscription(state);
        this.scheduleNextOverviewFrame(state, 450);
      }, 900);
    } catch (error) {
      state.subscriptionActive = false;
      this.previewErrors.set(state.spaceId, String(error));
      this.scheduleNextOverviewFrame(state, 1200);
    }
  }

  private scheduleNextOverviewFrame(
    state: OverviewScreencastState,
    delayMs: number,
  ) {
    if (this.overviewScreencast !== state || state.resubscribeTimer) return;
    state.nextFrameDelayMs = delayMs;
    state.resubscribeTimer = setTimeout(() => {
      state.resubscribeTimer = undefined;
      state.nextFrameDelayMs = 0;
      this.subscribeOverviewFrame(state);
    }, delayMs);
  }

  private endOverviewFrameSubscription(state: OverviewScreencastState) {
    if (state.frameTimeout) clearTimeout(state.frameTimeout);
    state.frameTimeout = undefined;
    if (!state.subscriptionActive) return;
    state.subscriptionActive = false;
    const contents = this.getView(state.targetId)?.webContents;
    if (!contents || contents.isDestroyed()) return;
    try {
      contents.endFrameSubscription();
    } catch {
      // The renderer may already be tearing down its compositor.
    }
  }

  private pauseOverviewFrameCapture() {
    const state = this.overviewScreencast;
    if (!state) return undefined;
    this.overviewFramePauseDepth += 1;
    if (this.overviewFramePauseDepth === 1) {
      if (state.resubscribeTimer) clearTimeout(state.resubscribeTimer);
      state.resubscribeTimer = undefined;
      this.endOverviewFrameSubscription(state);
    }
    return state;
  }

  private resumeOverviewFrameCapture(state?: OverviewScreencastState) {
    if (!state) return;
    this.overviewFramePauseDepth = Math.max(0, this.overviewFramePauseDepth - 1);
    if (
      this.overviewFramePauseDepth > 0 ||
      this.overviewScreencast !== state ||
      !this.previewActive
    ) {
      return;
    }
    this.scheduleNextOverviewFrame(state, 80);
  }

  private publishOverviewScreencastFrame(
    state: OverviewScreencastState,
    image: NativeImage,
  ) {
    if (
      this.overviewScreencast !== state ||
      !this.previewActive ||
      !this.visiblePreviewSpaceIds.has(state.spaceId)
    ) {
      return false;
    }
    const size = image.getSize();
    const signatureImage = image.resize({
      width: 24,
      height: 16,
      quality: "good",
    });
    const signature = quantizedPreviewSignature(
      signatureImage.toBitmap(),
      24,
      16,
    );
    const visualChanged = previewVisualChanged(
      state.lastVisualSignature,
      signature,
    );
    state.lastVisualSignature = signature;
    if (!visualChanged) return false;
    // A changed compositor frame is itself page activity. Keep genuinely
    // dynamic previews on the responsive cadence while allowing static pages
    // to continue backing off through unchanged-frame sampling.
    state.lastActivityAt = Date.now();
    const resized =
      size.width > 588
        ? image.resize({ width: 588, quality: "good" })
        : image;
    const data = resized.toJPEG(64);
    if (data.byteLength === 0) return false;
    const cached = this.previewCache.get(state.targetId);
    if (cached?.data?.equals(data)) return false;
    state.lastPublishedAt = Date.now();
    const revision = ++this.previewRevision;
    this.setPreviewCacheEntry(state.targetId, {
      data,
      capturedAt: state.lastPublishedAt,
      revision,
    });
    this.options.publishPreviewFrame({
      spaceId: state.spaceId,
      revision,
      data,
    });
    this.publishedPreviewRevision.set(state.spaceId, revision);
    state.publishedFrames += 1;
    return true;
  }

  private setPreviewCacheEntry(targetId: string, entry: PreviewCacheEntry) {
    this.previewCache.set(targetId, entry);
    this.trimPreviewCache();
  }

  private previewCacheBytes() {
    let total = 0;
    for (const entry of this.previewCache.values()) {
      total += entry.data?.byteLength ?? 0;
    }
    return total;
  }

  private trimPreviewCache() {
    let bytes = this.previewCacheBytes();
    if (
      this.previewCache.size <= MAX_PREVIEW_CACHE_ENTRIES &&
      bytes <= MAX_PREVIEW_CACHE_BYTES
    ) {
      return;
    }
    const protectedTargets = new Set<string>();
    if (this.presentedTargetId) protectedTargets.add(this.presentedTargetId);
    if (this.presentationReservedTargetId) {
      protectedTargets.add(this.presentationReservedTargetId);
    }
    if (this.overviewScreencast?.targetId) {
      protectedTargets.add(this.overviewScreencast.targetId);
    }
    for (const spaceId of this.visiblePreviewSpaceIds) {
      const targetId = this.getSpace(spaceId)?.activeTabId;
      if (targetId) protectedTargets.add(targetId);
    }
    const candidates = [...this.previewCache.entries()]
      .filter(
        ([targetId, entry]) =>
          !entry.pending && !protectedTargets.has(targetId),
      )
      .sort((left, right) => left[1].capturedAt - right[1].capturedAt);
    for (const [targetId, entry] of candidates) {
      if (
        this.previewCache.size <= MAX_PREVIEW_CACHE_ENTRIES &&
        bytes <= MAX_PREVIEW_CACHE_BYTES
      ) {
        break;
      }
      this.previewCache.delete(targetId);
      this.previewCacheEvictions += 1;
      bytes -= entry.data?.byteLength ?? 0;
      const space = this.findSpaceByTargetId(targetId);
      if (space?.activeTabId === targetId) {
        this.publishedPreviewRevision.delete(space.id);
      }
    }
  }

  private async stopOverviewScreencast(state: OverviewScreencastState) {
    if (this.overviewScreencast === state) this.overviewScreencast = undefined;
    if (state.resubscribeTimer) clearTimeout(state.resubscribeTimer);
    state.resubscribeTimer = undefined;
    this.endOverviewFrameSubscription(state);
    this.setPageForegroundCadence(
      state.targetId,
      "overview-live-preview",
      false,
    );
    this.previewPhases.delete(state.spaceId);
    this.schedulePreviewRecovery(state.spaceId, 0);
    if (
      this.presentedTargetId !== state.targetId &&
      !this.activeAgentConnections.has(state.spaceId)
    ) {
      await this.releaseBackgroundSurface(state.targetId);
      await this.releasePreviewOnlyRuntime(state.targetId);
    }
    this.schedulePreviewPump(0);
  }

  private async releaseInactiveAgentSurfaces(spaceId: number) {
    const space = this.getSpace(spaceId);
    if (!space) return;
    const targetIds = space.tabs.map((tab) => tab.targetId);
    const generations = new Map(
      targetIds.map((targetId) => [
        targetId,
        this.bumpSurfaceGeneration(targetId),
      ]),
    );
    await this.queueSurface(async () => {
      if (this.activeAgentConnections.has(spaceId)) return;
      for (const targetId of targetIds) {
        if (
          !this.isSurfaceGenerationCurrent(
            targetId,
            generations.get(targetId)!,
          ) ||
          this.isPresentationSurface(targetId) ||
          this.overviewScreencast?.targetId === targetId ||
          this.frameSubscriptionCaptures.has(targetId)
        ) {
          continue;
        }
        const view = this.getView(targetId);
        if (!view || !this.hiddenSurfaceTargets.has(targetId)) continue;
        this.detachBackgroundSurfaceNow(targetId, view);
      }
      this.hideCaptureWindowIfIdle();
    });
  }

  private schedulePreviewRecovery(spaceId: number, missingDelayMs: number) {
    const now = Date.now();
    const cached = this.cachedPreviewForSpace(spaceId);
    const hasPaintedFrame = Boolean(
      cached?.data || this.publishedPreviewRevision.has(spaceId),
    );
    const existing = this.previewDueAt.get(spaceId);
    if (Number.isFinite(existing) && Number(existing) > now) return;
    this.previewDueAt.set(
      spaceId,
      now + (hasPaintedFrame ? 850 : Math.max(0, missingDelayMs)),
    );
  }

  private mutate(spaceId: number, mutation: (space: SpaceRecord) => Promise<void>) {
    return this.enqueue(spaceId, async () => {
      const space = this.getSpaceOrThrow(spaceId);
      await mutation(space);
      await this.persistAndNotify();
    });
  }

  private mutateSoon(
    spaceId: number,
    mutation: (space: SpaceRecord) => Promise<void>,
  ) {
    return this.enqueue(spaceId, async () => {
      const space = this.getSpaceOrThrow(spaceId);
      await mutation(space);
      this.notify();
      void this.options.store.save(this.state).catch(() => undefined);
    });
  }

  private enqueue<T>(spaceId: number, operation: () => Promise<T>) {
    const previous = this.mutationQueues.get(spaceId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.mutationQueues.set(spaceId, next.catch(() => undefined));
    return next;
  }

  private async persistAndNotify() {
    await this.options.store.save(this.state);
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private broadcastControl(spaceId: number) {
    for (const listener of this.controlListeners) listener(spaceId);
  }

  private queueSurface<T>(operation: () => Promise<T>) {
    const next = this.surfaceQueue.then(operation, operation);
    this.surfaceQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private isPresentationSurface(targetId: string) {
    return (
      this.presentedTargetId === targetId ||
      this.presentationReservedTargetId === targetId
    );
  }

  private bumpSurfaceGeneration(targetId: string) {
    const generation = (this.surfaceGenerations.get(targetId) ?? 0) + 1;
    this.surfaceGenerations.set(targetId, generation);
    return generation;
  }

  private isSurfaceGenerationCurrent(targetId: string, generation: number) {
    return this.surfaceGenerations.get(targetId) === generation;
  }

  private ensureProfileSessionSetup(profileId: string) {
    let setup = this.profileSessionSetup.get(profileId);
    if (!setup) {
      setup = (async () => {
        const profile = this.options.profiles.getOrThrow(profileId);
        await this.options.beforeProfileSessionSetup?.(profileId);
        await ensureChromiumProfilePreferences(
          this.options.partitionsRoot,
          profileId,
          profile.partitionId,
        );
        const chromiumSession = session.fromPartition(
          `persist:${profile.partitionId}`,
        );
        await configureChromiumSession(chromiumSession);
      })();
      this.profileSessionSetup.set(profileId, setup);
    }
    return setup;
  }
}

function isRemoteWebUrl(value: string) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForViewport(view: WebContentsView) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const size = await view.webContents.executeJavaScript(
        "({ width: window.innerWidth, height: window.innerHeight })",
        false,
      );
      if (size?.width > 1 && size?.height > 1) return;
    } catch {
      // The page may still be replacing its execution context.
    }
    await delay(25);
  }
}
