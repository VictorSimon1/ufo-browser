import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BrowserProfileRegistry } from "./profile-registry.js";
import { BrowserStateStore } from "./state-store.js";
import type { SpaceLifecycle, SpaceOwnership, SpaceRecord, TabRecord } from "./types.js";
import {
  isTemporaryProfileId,
  isTemporarySpace,
  TEMPORARY_AGENT_PROFILE_ID,
  TEMPORARY_PROFILE_NAME,
  TEMPORARY_PROFILE_ID,
} from "./temporary-profile.js";
import {
  NativeCefRuntime,
  NativeCefSharedSpaceRuntime,
  type NativeCefRuntimeOptions,
} from "./native-cef-runtime.js";
import { seedNativeCefProfile } from "./native-cef-profile-seed.js";
import type { CookieWriteTarget } from "./chrome-import/cookie-writer.js";

export type NativeCefTaskSpaceManagerOptions = {
  store: BrowserStateStore;
  profiles: BrowserProfileRegistry;
  partitionsRoot: string;
  executable?: string;
  /** Development-only deterministic base. Omit in packaged Native builds. */
  portBase?: number;
  useMockKeychain?: boolean;
  sourcePartitionsRoot?: string;
  controlSocketsRoot?: string;
  devtoolsSocketsRoot?: string;
  /** Unix socket used by the native Chrome Spaces button. */
  presentationSocket?: string;
  /** Returns true only when Cookies were written and the initial page must reload. */
  seedCookies?: (profileId: string, target: CookieWriteTarget) => Promise<boolean | void>;
  onBeforeRuntimeStart?: (spaceId: number, profileId: string, dataDir: string) => Promise<void>;
  onRuntimeReady?: (spaceId: number, profileId: string, runtime: NativeCefRuntime) => Promise<void>;
  /** The one native CEF main process that owns all logical Space surfaces. */
  sharedHost?: NativeCefRuntime;
  ownsSharedHost?: boolean;
  /** Use Chromium-owned native Chrome windows for human-facing Spaces. */
  nativeChromeProductShell?: boolean;
  /** Chrome Runtime user-data root shared by the one native CEF host. */
  chromeUserDataRoot?: string;
};

export type NativeCefPresentationHooks = {
  onSpaceClosed?(spaceId: number): Promise<void> | void;
  onSpaceStateChanged?(spaceId: number): Promise<void> | void;
};

/**
 * Electron-free Task Space manager used by the native CEF Agent Host.
 *
 * A Space owns a persistent data directory, isolated CefRequestContext, and
 * target route inside the shared CEF Host. It never owns or launches another
 * CEF main process. CEF's own toolbar remains responsible for human tab UI
 * while the Agent protocol is layered on the active target.
 */
export class NativeCefTaskSpaceManager {
  private state = { version: 1 as const, nextSpaceId: 1, spaces: [] as SpaceRecord[] };
  private readonly runtimes = new Map<string, NativeCefRuntime>();
  private readonly browserConnections = new Map<string, any>();
  private readonly agentOverlayState = new Map<string, boolean>();
  private sharedHost?: NativeCefRuntime;
  private ownsSharedHost = false;
  private presentationHooks?: NativeCefPresentationHooks;
  private nextInternalSpaceId = 0x7fffffff;
  private readonly internalSpaceIds = new Set<number>();
  private readonly cookieSeedLocks = new Map<string, Promise<boolean>>();

  constructor(private readonly options: NativeCefTaskSpaceManagerOptions) {
    this.sharedHost = options.sharedHost;
    this.ownsSharedHost = Boolean(options.ownsSharedHost);
  }

  setSharedHost(host: NativeCefRuntime | undefined, ownsHost = false) {
    if (this.runtimes.size > 0 && host !== this.sharedHost) {
      throw new Error("cannot replace Native CEF shared host while Spaces are running");
    }
    this.sharedHost = host;
    this.ownsSharedHost = ownsHost;
  }

  setPresentationHooks(hooks: NativeCefPresentationHooks | undefined) {
    this.presentationHooks = hooks;
  }

  /** Register the profile/runtime hook after dependent services are created. */
  setRuntimeReadyHook(
    hook: NativeCefTaskSpaceManagerOptions["onRuntimeReady"] | undefined,
  ) {
    this.options.onRuntimeReady = hook;
  }

  setBeforeRuntimeStartHook(
    hook: NativeCefTaskSpaceManagerOptions["onBeforeRuntimeStart"] | undefined,
  ) {
    this.options.onBeforeRuntimeStart = hook;
  }

  async initialize() {
    const loaded = await this.options.store.load();
    this.state = loaded;
  }

  async flushState() {
    await this.options.store.flush();
  }

  listSpaces() {
    return this.state.spaces.map((space) => ({
      ...structuredClone(space),
      recentTabTitles: space.tabs.map((tab) => tab.title).filter(Boolean).slice(-3),
    }));
  }

  listProfiles() {
    return [
      {
        id: TEMPORARY_AGENT_PROFILE_ID,
        isDefault: false,
        name: TEMPORARY_PROFILE_NAME,
      },
      ...this.options.profiles.listPublic().map((profile) => ({
        id: profile.id === "default" ? "Default" : profile.id,
        isDefault: profile.isDefault,
        name: profile.name,
      })),
    ];
  }

  getSpace(spaceId: number) {
    return this.state.spaces.find((space) => space.id === spaceId);
  }

  getSpaceOrThrow(spaceId: number) {
    const space = this.getSpace(spaceId);
    if (!space) throw new Error(`task space not found: ${spaceId}`);
    return space;
  }

  async createSpace(name: string, createdBy: "agent" | "user" = "user", profileId?: string) {
    const temporary = isTemporaryProfileId(profileId);
    const profile = temporary ? undefined : profileId ? this.options.profiles.getOrThrow(profileId) : this.options.profiles.getDefault();
    const now = Date.now();
    const trimmed = name.trim() || `Space ${this.state.nextSpaceId}`;
    const tab = this.newTab("https://www.google.com/");
    const space: SpaceRecord = {
      id: this.state.nextSpaceId++,
      taskId: trimmed,
      name: trimmed,
      createdBy,
      ownership: createdBy === "agent" ? "agent" : "user",
      lifecycle: "active",
      profileId: temporary ? TEMPORARY_PROFILE_ID : profile!.id,
      profileMode: temporary ? "temporary" : "persistent",
      sessionScopeId: temporary ? `native-temporary-${randomUUID()}` : undefined,
      tabs: [tab],
      activeTabId: tab.targetId,
      agentTask: createdBy === "agent" ? {
        title: trimmed,
        detail: "Agent is preparing the native browser",
        completed: 0,
        total: 1,
        updatedAt: now,
      } : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.state.spaces.push(space);
    await this.save();
    return structuredClone(space);
  }

  async renameSpace(spaceId: number, name: string) {
    const space = this.getSpaceOrThrow(spaceId);
    space.name = name.trim() || space.name;
    space.taskId = space.name;
    space.updatedAt = Date.now();
    await this.save();
    return structuredClone(space);
  }

  async setOwnership(spaceId: number, ownership: SpaceOwnership, lifecycle: SpaceLifecycle = "active") {
    const space = this.getSpaceOrThrow(spaceId);
    space.ownership = ownership;
    space.lifecycle = lifecycle;
    space.updatedAt = Date.now();
    await this.save();
    await this.syncAgentOverlay(spaceId);
    if (ownership !== "agent") {
      // Handoff/completion returns the native browser surface to the human.
      // Do not start a cold Space just to show it; only an already-presented
      // runtime is eligible for this best-effort presentation update.
      await this.showRunningSpace(spaceId);
      await this.presentationHooks?.onSpaceStateChanged?.(spaceId);
    }
    return structuredClone(space);
  }

  async setLifecycle(spaceId: number, lifecycle: SpaceLifecycle) {
    // Completion/error always hands the surface back to the human. Keeping
    // ownership=agent after the task becomes inactive would leave a stale
    // control overlay after the short-lived CLI connection exits.
    return this.setOwnership(spaceId, "user", lifecycle);
  }

  async setAgentTaskState(spaceId: number, state: any) {
    const space = this.getSpaceOrThrow(spaceId);
    space.agentTask = {
      title: String(state?.title ?? space.agentTask?.title ?? space.name),
      detail: String(state?.detail ?? ""),
      completed: Number(state?.completed ?? 0),
      total: Number(state?.total ?? 1),
      updatedAt: Date.now(),
    };
    await this.save();
    const runtime = this.runtimes.get(this.runtimeKey(space));
    const host = this.sharedHost || runtime;
    if (runtime?.isRunning() && host?.isRunning()) {
      await host.updateSharedSpaceAgentOverlay(
        spaceId,
        space.agentTask.title,
        space.agentTask.detail || "Agent 正在控制",
      ).catch(() => undefined);
    }
  }

  async createAgentTab(spaceId: number, url = "https://www.google.com/") {
    const space = this.getSpaceOrThrow(spaceId);
    const tab = space.tabs[0];
    if (space.tabs.length !== 1 || tab.url !== "https://www.google.com/" || this.runtimes.has(this.runtimeKey(space))) {
      return this.createTab(spaceId, url);
    }
    tab.url = url;
    tab.title = "New Tab";
    space.updatedAt = Date.now();
    await this.save();
    await this.ensureRuntime(spaceId, url);
    return structuredClone(space.tabs[0]);
  }

  async createTab(spaceId: number, url = "https://www.google.com/") {
    const space = this.getSpaceOrThrow(spaceId);
    const runtime = await this.ensureRuntime(spaceId);
    const browser = await this.ensureBrowserConnection(spaceId, runtime);
    const created = runtime instanceof NativeCefSharedSpaceRuntime
      ? await runtime.createTarget(url)
      : await browser.send("Target.createTarget", { url });
    if (!created?.targetId) throw new Error("Native CEF did not create a tab target");
    (runtime as NativeCefSharedSpaceRuntime).rememberTargetId?.(String(created.targetId));
    const target = await waitForTarget(runtime, created.targetId, 15_000);
    (runtime as NativeCefSharedSpaceRuntime).rememberTargetId?.(target.id);
    await waitForRendererNavigation(runtime, target.id, url, 15_000);
    const tab = this.newTab(target.url || url);
    tab.targetId = target.id;
    tab.title = target.title || "";
    space.tabs.push(tab);
    space.activeTabId = tab.targetId;
    space.updatedAt = Date.now();
    await this.save();
    await browser.send("Target.activateTarget", { targetId: tab.targetId }).catch(() => undefined);
    return structuredClone(space.tabs.at(-1));
  }

  async activateTab(spaceId: number, targetId: string) {
    const space = this.getSpaceOrThrow(spaceId);
    if (!space.tabs.some((tab) => tab.targetId === targetId)) throw new Error(`tab not found: ${targetId}`);
    const runtime = await this.ensureRuntime(spaceId);
    const browser = await this.ensureBrowserConnection(spaceId, runtime);
    await browser.send("Target.activateTarget", { targetId });
    space.activeTabId = targetId;
    space.updatedAt = Date.now();
    await this.save();
    return structuredClone(space);
  }

  async closeTab(spaceId: number, targetId: string) {
    const space = this.getSpaceOrThrow(spaceId);
    const index = space.tabs.findIndex((tab) => tab.targetId === targetId);
    if (index < 0) throw new Error(`tab not found: ${targetId}`);
    const runtime = await this.ensureRuntime(spaceId);
    const browser = await this.ensureBrowserConnection(spaceId, runtime);
    await browser.send("Target.closeTarget", { targetId }).catch(() => undefined);
    space.tabs.splice(index, 1);
    if (space.tabs.length === 0) {
      const replacement = this.newTab("https://www.google.com/");
      const created = runtime instanceof NativeCefSharedSpaceRuntime
        ? await runtime.createTarget(replacement.url)
        : await browser.send("Target.createTarget", { url: replacement.url });
      replacement.targetId = created.targetId;
      await waitForTarget(runtime, replacement.targetId, 15_000);
      space.tabs.push(replacement);
    }
    if (!space.tabs.some((tab) => tab.targetId === space.activeTabId)) {
      space.activeTabId = space.tabs[Math.min(index, space.tabs.length - 1)].targetId;
    }
    space.updatedAt = Date.now();
    await this.save();
  }

  async refreshTabs(spaceId: number) {
    const space = this.getSpaceOrThrow(spaceId);
    const runtime = await this.ensureRuntime(spaceId);
    const targets = (await runtime.targets()).filter((target) => target.type === "page");
    return this.reconcilePageTargets(space, targets);
  }

  async refreshTabsFromTargetInfos(spaceId: number, targetInfos: any[]) {
    const space = this.getSpaceOrThrow(spaceId);
    const targets = targetInfos
      .filter((target) => target.type === "page")
      .map((target) => ({
        id: target.targetId,
        type: target.type,
        title: target.title,
        url: target.url,
      }));
    return this.reconcilePageTargets(space, targets);
  }

  private async reconcilePageTargets(space: SpaceRecord, targets: any[]) {
    const known = new Map(space.tabs.map((tab) => [tab.targetId, tab]));
    const liveIds = new Set(targets.map((target) => target.id));
    for (const target of targets) {
      const tab = known.get(target.id);
      if (tab) {
        tab.url = target.url || tab.url;
        tab.title = target.title || tab.title;
      }
    }
    // Chrome Runtime can create popup/window.open targets without going
    // through UFO's explicit createTab RPC. Promote newly observed page
    // targets into the Space tab list so page.waitForEvent('popup') and the
    // existing listTabs helper see the same target set as Electron.
    for (const target of targets) {
      if (known.has(target.id)) continue;
      const tab = this.newTab(target.url || "about:blank");
      tab.targetId = target.id;
      tab.title = target.title || "";
      space.tabs.push(tab);
      known.set(target.id, tab);
    }
    space.tabs = space.tabs.filter((tab) => liveIds.has(tab.targetId));
    if (space.tabs.length === 0 && targets.length > 0) {
      const target = targets[0];
      space.tabs = [{ targetId: target.id, url: target.url, title: target.title, createdAt: Date.now() }];
    }
    const active = targets.find((target) => target.id === space.activeTabId);
    if (active) space.activeTabId = active.id;
    // Tab enumeration is latency-sensitive (page.waitForEvent('popup') polls
    // it). Persist the reconciled metadata in the background so a slow disk
    // flush or a concurrent profile checkpoint cannot block listTabs.
    void this.save().catch(() => undefined);
    return structuredClone(space.tabs);
  }

  async closeSpace(spaceId: number) {
    const index = this.state.spaces.findIndex((space) => space.id === spaceId);
    if (index < 0) return false;
    const space = this.state.spaces[index];
    const runtimeKey = this.runtimeKey(space);
    const runtime = this.runtimes.get(runtimeKey);
    const browser = this.browserConnections.get(runtimeKey);
    for (const tab of space.tabs) await browser?.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined);
    this.runtimes.delete(runtimeKey);
    this.browserConnections.delete(runtimeKey);
    this.agentOverlayState.delete(runtimeKey);
    await browser?.close().catch(() => undefined);
    await runtime?.stop().catch(() => undefined);
    if (isTemporarySpace(space)) {
      // The real browsing state lives in the unique cache-less CEF OTR
      // Profile. Remove UFO's empty per-Space staging directory as part of the
      // same close boundary so a completed Temporary Space leaves no reusable
      // filesystem identity behind.
      await rm(join(this.options.partitionsRoot, this.runtimeDataDirectory(space)), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    this.state.spaces.splice(index, 1);
    await this.save();
    await this.presentationHooks?.onSpaceClosed?.(spaceId);
    return true;
  }

  async ensureRuntime(spaceId: number, url?: string) {
    const space = this.getSpaceOrThrow(spaceId);
    const runtimeKey = this.runtimeKey(space);
    const existing = this.runtimes.get(runtimeKey);
    if (existing?.isRunning()) return existing;
    const tab = space.tabs.find((candidate) => candidate.targetId === space.activeTabId) ?? space.tabs[0];
    if (!tab) throw new Error("native Space has no active tab");
    const realChromeProfile = Boolean(
      this.sharedHost &&
      this.options.nativeChromeProductShell &&
      this.options.chromeUserDataRoot &&
      space.profileMode === "persistent"
    );
    const chromeProfileDirectory = realChromeProfile
      ? this.chromeProfileDirectory(space.profileId)
      : undefined;
    const dataDir = realChromeProfile
      ? join(this.options.chromeUserDataRoot!, chromeProfileDirectory!)
      : join(this.options.partitionsRoot, this.runtimeDataDirectory(space));
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (space.profileMode === "persistent") {
      const sourceRoot = this.options.sourcePartitionsRoot
        ? this.profileSourceRoot(this.options.profiles.getOrThrow(space.profileId))
        : undefined;
      const profileSeed = await seedNativeCefProfile({
        sourceRoot,
        targetRoot: dataDir,
        sourceProfileId: space.profileId,
      });
      await this.options.onBeforeRuntimeStart?.(space.id, space.profileId, dataDir);
    }
    const runtimeOptions: NativeCefRuntimeOptions = {
      executable: this.options.executable,
      url: url || tab.url,
      // Every human-facing Space is a real Chrome window. Keep this explicit
      // so future diagnostic/plain-page launches cannot silently change the
      // product shell while Agent/CDP behavior remains identical.
      chromeShell: true,
      // UFO owns this metadata; it is drawn in AppKit and never enters the
      // page compositor, Agent screenshot, or DOM surface.
      spaceName: space.name,
      profileName: space.profileMode === "temporary"
        ? "Temporary"
        : this.options.profiles.getOrThrow(space.profileId).name,
      // Development smoke tests may pin a base for repeatability. Packaged
      // Native runs leave the base unset and receive an ephemeral loopback
      // port, so no predictable DevTools endpoint is exposed.
      port: this.options.portBase
        ? this.options.portBase + this.runtimePortOffset(runtimeKey)
        : await findFreePort(),
      userDataDir: dataDir,
      // Darwin sockaddr_un paths are limited to roughly 104 bytes. Profile
      // directories can be much deeper than that, so never nest the socket
      // inside the CEF user-data directory.
      controlSocket: join(
        this.options.controlSocketsRoot || join(this.options.partitionsRoot, "..", "Control"),
        `space-${space.id}.sock`,
      ),
      presentationSocket: this.options.presentationSocket,
      // Native Spaces use the private CEF bridge by default. Set
      // UFO_CEF_PRIVATE_BRIDGE=0 only for legacy diagnostics that explicitly
      // need the loopback DevTools HTTP endpoint during migration.
      devtoolsSocket: process.env.UFO_CEF_PRIVATE_BRIDGE !== "0"
        ? join(
            this.options.devtoolsSocketsRoot || join(this.options.partitionsRoot, "..", "DevTools"),
            `space-${space.id}.sock`,
          )
        : undefined,
      useMockKeychain: this.options.useMockKeychain,
    };
    const runtime = this.sharedHost
      ? new NativeCefSharedSpaceRuntime(this.sharedHost, {
          id: space.id,
          url: runtimeOptions.url || tab.url,
          cachePath: dataDir,
          name: space.name,
          profileName: runtimeOptions.profileName,
          visible: false,
          nativeChromeShell: this.options.nativeChromeProductShell,
          temporary: space.profileMode === "temporary",
          chromeProfileDirectory,
          chromeUserDataRoot: realChromeProfile
            ? this.options.chromeUserDataRoot
            : undefined,
        })
      : new NativeCefRuntime(runtimeOptions);
    if (runtimeOptions.controlSocket) await mkdir(dirname(runtimeOptions.controlSocket), { recursive: true, mode: 0o700 });
    // The private CEF DevTools bridge is a per-Space Unix socket. Create its
    // short-lived parent before launching CEF; otherwise the host cannot bind
    // the socket and the Agent reports a misleading ENOENT while bootstrapping
    // the first Space.
    if (runtimeOptions.devtoolsSocket) {
      await mkdir(dirname(runtimeOptions.devtoolsSocket), { recursive: true, mode: 0o700 });
    }
    await runtime.start();
    let cookiesSeeded = false;
    if (space.profileMode === "persistent" && this.options.seedCookies) {
      cookiesSeeded = await this.seedCookiesOnce(space.profileId, runtime, space, dataDir);
    }
    const target = await waitForPageTarget(runtime, tab.url, 15_000);
    if (!target) {
      await runtime.stop();
      throw new Error("Native CEF did not expose a page target");
    }
    (runtime as NativeCefSharedSpaceRuntime).rememberTargetId?.(target.id);
    if (cookiesSeeded) {
      // The native Chrome window begins navigating as soon as it is created.
      // First-run Cookie import happens through that live target, so its
      // initial Google request cannot have included the newly written login
      // state. Re-navigate before presentation instead of making the user
      // reload a visibly logged-out first page.
      await navigateAfterCookieSeed(runtime, target.id, tab.url, 15_000);
    }
    await waitForRendererNavigation(runtime, target.id, tab.url, 15_000);
    const previousTargetId = tab.targetId;
    tab.targetId = target.id;
    if (space.activeTabId === previousTargetId) space.activeTabId = target.id;
    tab.url = target.url || tab.url;
    tab.title = target.title || tab.title;
    this.runtimes.set(runtimeKey, runtime);
    const overlayActive = space.ownership === "agent" && space.lifecycle === "active";
    this.agentOverlayState.set(runtimeKey, overlayActive);
    if (overlayActive) {
      await runtime.control("agent-active-on").catch(() => undefined);
      const host = this.sharedHost || runtime;
      await host.updateSharedSpaceAgentOverlay(
        spaceId,
        space.agentTask?.title || space.name,
        space.agentTask?.detail || "Agent 正在控制",
      ).catch(() => undefined);
    }
    await this.save();
    if (space.profileMode === "persistent") {
      await this.options.onRuntimeReady?.(space.id, space.profileId, runtime);
    }
    return runtime;
  }

  getRuntime(spaceId: number) {
    const space = this.getSpaceOrThrow(spaceId);
    return this.runtimes.get(this.runtimeKey(space));
  }

  /**
   * Cookie import is a first-run operation for a Native Profile directory.
   * Real Chrome Profile Spaces share that directory, so repeating the full
   * source Cookie write for every Space open is both wasteful and unsafe: the
   * browser may normalize attributes that cannot round-trip byte-for-byte.
   * Serialize concurrent first opens and leave a small local marker only after
   * the transaction has completed. Later source changes are handled by the
   * Profile Sync checkpoint path, never by re-seeding on every launch.
   */
  private async seedCookiesOnce(
    profileId: string,
    runtime: NativeCefRuntime,
    space: SpaceRecord,
    dataDir: string,
  ) {
    const markerPath = join(dataDir, ".ufo-cookie-seed.json");
    if (await this.hasCompletedCookieSeed(markerPath, profileId)) return false;
    const inFlight = this.cookieSeedLocks.get(dataDir);
    if (inFlight) {
      return inFlight;
    }
    const operation = (async () => {
      if (await this.hasCompletedCookieSeed(markerPath, profileId)) return false;
      const target = await this.createNativeCookieTarget(runtime, space);
      let cookiesWritten = false;
      try {
        cookiesWritten = await this.options.seedCookies?.(profileId, target) === true;
      } finally {
        await target.dispose();
      }
      await this.writeCookieSeedMarker(profileId, dataDir, "imported");
      return cookiesWritten;
    })();
    this.cookieSeedLocks.set(dataDir, operation);
    try {
      return await operation;
    } finally {
      if (this.cookieSeedLocks.get(dataDir) === operation) {
        this.cookieSeedLocks.delete(dataDir);
      }
    }
  }

  private async writeCookieSeedMarker(
    profileId: string,
    dataDir: string,
    reason: string,
  ) {
    const markerPath = join(dataDir, ".ufo-cookie-seed.json");
    await writeFile(markerPath, `${JSON.stringify({
      version: 1,
      profileId,
      reason,
      seededAt: Date.now(),
    })}\n`, { mode: 0o600 });
    await chmod(markerPath, 0o600);
  }

  private async hasCompletedCookieSeed(markerPath: string, profileId: string) {
    try {
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      return marker?.version === 1 &&
        marker?.profileId === profileId &&
        marker?.reason === "imported";
    } catch {
      // Missing, malformed, and markers written by the old Profile-storage
      // migration are not proof that Cookies were imported. Retry safely and
      // only replace the marker after the Cookie transaction succeeds.
      return false;
    }
  }

  listRunningSpaces(profileId?: string) {
    return this.state.spaces
      .filter((space) => (!profileId || space.profileId === profileId) && this.runtimes.get(this.runtimeKey(space))?.isRunning())
      .map((space) => structuredClone(space));
  }

  async createCookieWriteTarget(spaceId: number): Promise<CookieWriteTarget> {
    const space = this.getSpaceOrThrow(spaceId);
    const runtime = this.runtimes.get(this.runtimeKey(space));
    if (!runtime?.isRunning()) throw new Error("native Space runtime is not running");
    return this.createNativeCookieTarget(runtime, space);
  }

  /**
   * Create a short-lived CEF target for Profile operations. Profile import and
   * clone use the same CDP Cookie adapter as a live Space, but must not create
   * a visible Task Space or keep a renderer alive after the transaction.
   */
  async createProfileCookieWriteTarget(profileId: string, partitionId?: string): Promise<CookieWriteTarget> {
    // Chrome import creates the target partition before the Profile Registry
    // publish step, so the target may intentionally not exist in the registry
    // yet. Registered clone targets use the explicit partition id as well.
    const targetPartition = partitionId || this.options.profiles.getOrThrow(profileId).partitionId;
    const dataDir = join(this.options.partitionsRoot, targetPartition);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    // The production Native app already owns one shared UFO CEF Host. Profile
    // import/clone must create its short-lived RequestContext inside that Host
    // instead of launching a second browser process against the target data.
    if (this.sharedHost?.isRunning()) {
      const internalSpaceId = this.allocateInternalSpaceId();
      const runtime = new NativeCefSharedSpaceRuntime(this.sharedHost, {
        id: internalSpaceId,
        url: "https://example.com/",
        cachePath: dataDir,
        name: "Profile Operation",
        profileName: profileId,
        visible: false,
        chromeShell: false,
      });
      try {
        await runtime.start();
        const target = await this.createCookieTargetForRuntime(runtime, "https://example.com/");
        const disposeTarget = target.dispose;
        let disposed = false;
        target.dispose = async () => {
          if (disposed) return;
          disposed = true;
          try {
            await disposeTarget();
          } finally {
            try {
              await runtime.stop();
            } finally {
              this.internalSpaceIds.delete(internalSpaceId);
            }
          }
        };
        return target;
      } catch (error) {
        await runtime.stop().catch(() => undefined);
        this.internalSpaceIds.delete(internalSpaceId);
        throw error;
      }
    }
    // Explicit standalone runtimes remain only for isolated component tests
    // and legacy callers that do not provide the product's shared Host.
    const controlSocket = join(
      this.options.controlSocketsRoot || join(this.options.partitionsRoot, "..", "Control"),
      `profile-${randomUUID()}.sock`,
    );
    const runtime = new NativeCefRuntime({
      executable: this.options.executable,
      url: "https://example.com/",
      port: await findFreePort(),
      userDataDir: dataDir,
      controlSocket,
      useMockKeychain: this.options.useMockKeychain,
    });
    await mkdir(dirname(controlSocket), { recursive: true, mode: 0o700 });
    try {
      await runtime.start();
      const target = await this.createCookieTargetForRuntime(runtime, "https://example.com/");
      const dispose = target.dispose;
      target.dispose = async () => {
        await dispose();
        await runtime.stop();
      };
      return target;
    } catch (error) {
      await runtime.stop().catch(() => undefined);
      throw error;
    }
  }

  isProfileInUse(profileId: string) {
    return this.state.spaces.some((space) => space.profileId === profileId);
  }

  /** Capture one low-frequency Overview frame through the active CEF page. */
  async capturePreview(spaceId: number) {
    const space = this.getSpaceOrThrow(spaceId);
    // Overview must not turn every cold Space into a live CEF process just to
    // paint a card. A preview is available once the Space is already running
    // (opened by a human or used by an Agent); otherwise the card remains a
    // lightweight placeholder until presentation starts the runtime.
    const runtime = this.getRuntime(spaceId);
    if (!runtime?.isRunning()) return undefined;
    // Human-owned background Spaces are ordered out between captures to keep
    // their native Chromium compositor idle. Wake only the one Space selected
    // by the global preview queue; the Host refuses to sleep a presented or
    // Agent-owned Space, so this is safe for active automation.
    await runtime.control("wake").catch(() => undefined);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    let connection: Awaited<ReturnType<NativeCefRuntime["connect"]>> | undefined;
    try {
      const active = this.getActiveTab(spaceId);
      const targets = await runtime.targets();
      const target = targets.find((candidate) =>
        candidate.type === "page" && candidate.id === active?.targetId,
      ) ?? targets.find((candidate) => candidate.type === "page");
      if (!target || (!target.webSocketDebuggerUrl && !runtime.usesPrivateBridge())) throw new Error("native preview page target is unavailable");
      connection = await runtime.connect(target.id);
      const result = await connection.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 58,
        captureBeyondViewport: false,
        fromSurface: true,
      });
      const data = String(result?.data || "");
      if (!data) throw new Error("native preview screenshot is empty");
      const tab = space.tabs.find((candidate) => candidate.targetId === target.id) ?? active;
      return {
        dataUrl: `data:image/jpeg;base64,${data}`,
        url: target.url || tab?.url || "",
        title: target.title || tab?.title || "",
        capturedAt: Date.now(),
      };
    } finally {
      await connection?.close();
      await runtime.control("sleep").catch(() => undefined);
    }
  }

  async showSpace(spaceId: number) {
    const runtime = await this.ensureRuntime(spaceId);
    return runtime.control("show").catch(async (error) => {
      if (!runtime.hasExited()) throw error;
      this.runtimes.delete(this.runtimeKey(this.getSpaceOrThrow(spaceId)));
      return (await this.ensureRuntime(spaceId)).control("show");
    });
  }

  async hideSpace(spaceId: number) {
    const runtime = await this.ensureRuntime(spaceId);
    return runtime.control("hide");
  }

  async hideRunningSpaces(exceptSpaceId?: number) {
    const pending: Promise<unknown>[] = [];
    for (const space of this.state.spaces) {
      if (space.id === exceptSpaceId) continue;
      const runtime = this.runtimes.get(this.runtimeKey(space));
      if (runtime?.isRunning()) pending.push(runtime.control("hide").catch(() => undefined));
    }
    await Promise.all(pending);
  }

  async presentSpace(spaceId: number) {
    await this.hideRunningSpaces(spaceId);
    await this.showSpace(spaceId);
    await this.focusSpace(spaceId);
  }

  async focusSpace(spaceId: number) {
    const runtime = await this.ensureRuntime(spaceId);
    return runtime.control("focus").catch(async (error) => {
      if (!runtime.hasExited()) throw error;
      this.runtimes.delete(this.runtimeKey(this.getSpaceOrThrow(spaceId)));
      return (await this.ensureRuntime(spaceId)).control("focus");
    });
  }

  private async showRunningSpace(spaceId: number) {
    const space = this.getSpaceOrThrow(spaceId);
    const runtime = this.runtimes.get(this.runtimeKey(space));
    if (!runtime?.isRunning()) return undefined;
    return runtime.control("show").catch(() => undefined);
  }

  getActiveTab(spaceId: number) {
    const space = this.getSpaceOrThrow(spaceId);
    return space.tabs.find((tab) => tab.targetId === space.activeTabId) ?? space.tabs[0];
  }

  async ensureTabRuntime(spaceId: number, targetId: string) {
    const runtime = await this.ensureRuntime(spaceId);
    const tab = this.getSpaceOrThrow(spaceId).tabs.find((candidate) => candidate.targetId === targetId);
    if (!tab) throw new Error(`tab not found: ${targetId}`);
    return runtime;
  }

  setAgentConnectionActive(spaceId: number, _active: boolean) {
    // The CLI is intentionally short-lived. Overlay ownership belongs to the
    // Space state, not to a transient socket connection, so disconnecting a
    // command runner must not silently return control to the human.
    void this.syncAgentOverlay(spaceId);
  }

  private async syncAgentOverlay(spaceId: number) {
    const space = this.getSpace(spaceId);
    if (!space) return;
    const runtimeKey = this.runtimeKey(space);
    const active = space.ownership === "agent" && space.lifecycle === "active";
    this.agentOverlayState.set(runtimeKey, active);
    const runtime = this.runtimes.get(runtimeKey);
    if (runtime?.isRunning()) {
      await runtime.control(active ? "agent-active-on" : "agent-active-off").catch(() => undefined);
      if (active) {
        const host = this.sharedHost || runtime;
        await host.updateSharedSpaceAgentOverlay(
          spaceId,
          space.agentTask?.title || space.name,
          space.agentTask?.detail || "Agent 正在控制",
        ).catch(() => undefined);
      }
    }
  }
  showAgentPointer(spaceId: number, x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const space = this.getSpace(spaceId);
    if (!space || space.ownership !== "agent" || space.lifecycle !== "active") return;
    const runtime = this.runtimes.get(this.runtimeKey(space));
    const host = this.sharedHost || runtime;
    if (!runtime?.isRunning() || !host?.isRunning()) return;
    void host.showSharedSpaceAgentPointer(
      spaceId,
      Math.max(0, x),
      Math.max(0, y),
    ).catch(() => undefined);
  }

  async shutdown() {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    this.agentOverlayState.clear();
    const browsers = [...this.browserConnections.values()];
    this.browserConnections.clear();
    await Promise.all(runtimes.map((runtime) => runtime.stop().catch(() => undefined)));
    await Promise.all(browsers.map((browser) => browser.close().catch(() => undefined)));
    if (this.ownsSharedHost) {
      await this.sharedHost?.stop().catch(() => undefined);
      this.sharedHost = undefined;
      this.ownsSharedHost = false;
    }
    if (this.options.controlSocketsRoot) {
      await rm(this.options.controlSocketsRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private newTab(url: string): TabRecord {
    return { targetId: `native-tab-${randomUUID()}`, url, title: "", createdAt: Date.now() };
  }

  private save() {
    return this.options.store.save(this.state);
  }

  private async ensureBrowserConnection(spaceId: number, runtime: NativeCefRuntime) {
    const space = this.getSpaceOrThrow(spaceId);
    const key = this.runtimeKey(space);
    const existing = this.browserConnections.get(key);
    if (existing) return existing;
    const browser = await runtime.connectBrowser();
    this.browserConnections.set(key, browser);
    return browser;
  }

  async ensureBrowserConnectionForAgent(spaceId: number, runtime: NativeCefRuntime) {
    return this.ensureBrowserConnection(spaceId, runtime);
  }

  private runtimeKey(space: SpaceRecord) {
    return `space-${space.id}`;
  }

  private runtimeDataDirectory(space: SpaceRecord) {
    return isTemporarySpace(space) ? `space-${space.id}` : `profile-${space.profileId}/space-${space.id}`;
  }

  private chromeProfileDirectory(profileId: string) {
    if (profileId === "default") return "Default";
    const profile = this.options.profiles.getOrThrow(profileId);
    const suffix = profile.partitionId.replace(/^x-browser-profile-/, "");
    return `UFO-${suffix}`;
  }

  private profileSourceRoot(profile: ReturnType<BrowserProfileRegistry["getOrThrow"]>) {
    if (profile.source?.type === "ufo") {
      const sourceProfile = this.options.profiles.getOrThrow(profile.source.profileId);
      return join(this.options.sourcePartitionsRoot!, sourceProfile.partitionId);
    }
    return join(this.options.sourcePartitionsRoot!, profile.partitionId);
  }

  private runtimePortOffset(key: string) {
    return Number(key.replace(/\D/g, "")) || 1;
  }

  private allocateInternalSpaceId() {
    while (this.nextInternalSpaceId > 1_000_000_000) {
      const candidate = this.nextInternalSpaceId--;
      if (this.internalSpaceIds.has(candidate) || this.getSpace(candidate)) continue;
      this.internalSpaceIds.add(candidate);
      return candidate;
    }
    throw new Error("Native CEF internal Space id range exhausted");
  }

  private async createNativeCookieTarget(runtime: NativeCefRuntime, space: SpaceRecord): Promise<CookieWriteTarget> {
    return this.createCookieTargetForRuntime(runtime, space.tabs[0]?.url || "");
  }

  private async createCookieTargetForRuntime(runtime: NativeCefRuntime, expectedUrl: string): Promise<CookieWriteTarget> {
    const target = await waitForPageTarget(runtime, expectedUrl, 15_000);
    if (!target) throw new Error("Native CEF cookie target did not become ready");
    const connection = await runtime.connect(target.id);
    await connection.send("Network.enable");
    const cookies = {
      get: async () => {
        const result = await connection.send("Network.getAllCookies");
        return (result?.cookies ?? []).map((cookie: any) => ({
          name: String(cookie.name || ""),
          value: String(cookie.value || ""),
          domain: String(cookie.domain || ""),
          hostOnly: !String(cookie.domain || "").startsWith("."),
          path: String(cookie.path || "/"),
          secure: Boolean(cookie.secure),
          httpOnly: Boolean(cookie.httpOnly),
          sameSite: cookie.sameSite === "None" ? "no_restriction" :
            cookie.sameSite === "Lax" ? "lax" :
              cookie.sameSite === "Strict" ? "strict" : "unspecified",
          session: Boolean(cookie.session),
          expirationDate: Number(cookie.expires) || 0,
        })) as any[];
      },
      set: async (details: any) => {
        const sameSite = details.sameSite === "no_restriction" ? "None" :
          details.sameSite === "lax" ? "Lax" :
            details.sameSite === "strict" ? "Strict" : undefined;
        const result = await connection.send("Network.setCookie", {
          name: details.name,
          value: details.value,
          url: details.url,
          domain: details.domain,
          path: details.path,
          secure: details.secure,
          httpOnly: details.httpOnly,
          sameSite,
          expires: details.expirationDate,
        });
        if (result?.success === false) throw new Error("native CEF Cookie write failed");
      },
      remove: async (url: string, name: string) => {
        await connection.send("Network.deleteCookies", { url, name });
      },
    };
    return {
      cookies,
      cdp: connection,
      flush: async () => undefined,
      dispose: () => connection.close(),
    };
  }
}

async function findFreePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("unable to allocate Native CEF Profile operation port");
  return port;
}

async function isRegularFile(path: string) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForPageTarget(runtime: NativeCefRuntime, expectedUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastTarget: any;
  while (Date.now() < deadline) {
    const pages = (await runtime.targets()).filter((candidate) => candidate.type === "page");
    const readyPages = pages.filter((target) =>
      (target.webSocketDebuggerUrl || runtime.usesPrivateBridge()) &&
      target.url && target.url !== "about:blank");
    const target = readyPages.find((candidate) =>
      !expectedUrl || candidate.url === expectedUrl || candidate.url.startsWith(expectedUrl));
    if (target) return target;
    if (readyPages.length > 0) {
      // Preserve the legacy timeout fallback, but never let the first
      // process-wide target (often Overview in a shared Chrome Profile)
      // prevent a later exact URL match from being considered.
      lastTarget = readyPages[0];
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (lastTarget && (lastTarget.webSocketDebuggerUrl || runtime.usesPrivateBridge())) return lastTarget;
  throw new Error("Native CEF page target did not become ready");
}

async function waitForRendererNavigation(runtime: NativeCefRuntime, targetId: string, expectedUrl: string, timeoutMs: number) {
  const connection = await runtime.connect(targetId);
  const deadline = Date.now() + timeoutMs;
  const repairAt = Date.now() + 500;
  let navigationReissued = false;
  let lastUrl = "";
  try {
    await sendCdpWithTimeout(connection, "Page.enable", {}, 2_000)
      .catch(() => undefined);
    while (Date.now() < deadline) {
      const result = await sendCdpWithTimeout(connection, "Runtime.evaluate", {
        expression: "({ href: location.href, ready: document.readyState })",
        returnByValue: true,
      }, 2_000).catch(() => undefined);
      const value = result?.result?.value;
      const url = typeof value?.href === "string" ? value.href : "";
      lastUrl = url || lastUrl;
      if (url && url !== "about:blank" &&
          (!expectedUrl || url === expectedUrl || url.startsWith(expectedUrl)) &&
          (value?.ready === "interactive" || value?.ready === "complete")) {
        return;
      }
      // Chrome Runtime can publish the final URL in /json/list before the
      // page renderer behind that target has committed anything. Without a
      // bounded repair, the first Agent session attaches to about:blank and
      // the human has to click/reload the Space before it becomes usable.
      // Reissue only the Space's own requested navigation and only once.
      if (!navigationReissued && expectedUrl && Date.now() >= repairAt) {
        navigationReissued = true;
        await sendCdpWithTimeout(
          connection,
          "Page.navigate",
          { url: expectedUrl },
          3_000,
        ).catch(() => undefined);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(
      `Native CEF renderer did not commit ${expectedUrl || "a page"}; last URL: ${lastUrl || "unknown"}`,
    );
  } finally {
    await connection.close();
  }
}

function sendCdpWithTimeout(
  connection: { send(method: string, params?: Record<string, unknown>): Promise<any> },
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    connection.send(method, params),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Native CEF CDP timed out: ${method}`)),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function navigateAfterCookieSeed(
  runtime: NativeCefRuntime,
  targetId: string,
  url: string,
  timeoutMs: number,
) {
  const connection = await runtime.connect(targetId);
  const deadline = Date.now() + timeoutMs;
  try {
    await connection.send("Page.enable");
    await connection.send("Page.navigate", { url });
    while (Date.now() < deadline) {
      const result = await connection.send("Runtime.evaluate", {
        expression: "({ href: location.href, ready: document.readyState })",
        returnByValue: true,
      }).catch(() => undefined);
      const value = result?.result?.value;
      const href = value?.href;
      if (typeof href === "string" &&
          href !== "about:blank" &&
          (!url || href === url || href.startsWith(url)) &&
          (value?.ready === "interactive" || value?.ready === "complete")) {
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  } finally {
    await connection.close();
  }
}

async function waitForTarget(runtime: NativeCefRuntime, targetId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = (await runtime.targets()).find((candidate) => candidate.id === targetId);
    if (target && (target.webSocketDebuggerUrl || runtime.usesPrivateBridge())) return target;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Native CEF target did not become ready: ${targetId}`);
}
