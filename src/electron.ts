import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  app,
  BaseWindow,
  ipcMain,
  session,
  type IpcMainInvokeEvent,
  WebContentsView,
} from "electron";
import { AgentServer } from "./main/agent-server.js";
import { CdpBroker } from "./main/cdp-broker.js";
import { TaskSpaceManager } from "./main/manager.js";
import { PresentationCoordinator } from "./main/presentation-coordinator.js";
import { NativeSpaceTransition } from "./main/native-space-transition.js";
import {
  NativeBrowserChrome,
  type NativeBrowserChromeEvent,
} from "./main/native-browser-chrome.js";
import { SnapshotService } from "./main/snapshot.js";
import { AgentTraceService } from "./main/agent-trace.js";
import { SpaceEventJournal } from "./main/space-event-journal.js";
import { WorkflowService } from "./main/workflow-service.js";
import { ProfileRequestService } from "./main/profile-request.js";
import { SpaceLeaseRegistry } from "./main/space-lease.js";
import { BrowserStateStore } from "./main/state-store.js";
import {
  BrowserProfileRegistry,
  cleanupPendingProfilePartitions,
} from "./main/profile-registry.js";
import { recoverChromeImportJobs } from "./main/chrome-import/transaction.js";
import { ChromeLoginImportService } from "./main/chrome-import/service.js";
import { createChromeStableSourceAdapter } from "./main/chrome-import/discovery.js";
import { createElectronCookieWriteTarget } from "./main/chrome-import/electron-target.js";
import { createChromeStoragePreflightWorker } from "./main/chrome-import/storage-preflight-worker.js";
import { readChromeCookies } from "./main/chrome-import/cookies.js";
import { createChromeCookieWorkerReader } from "./main/chrome-import/worker-reader.js";
import { ProfileSyncCheckpointStore } from "./main/profile-sync/checkpoint-store.js";
import { createProfileCookieDiffWorker } from "./main/profile-sync/cookie-diff-worker-reader.js";
import { ProfileSyncService } from "./main/profile-sync/service.js";
import { ProfileStorageSyncService } from "./main/profile-sync/storage-sync.js";
import { createStorageRevisionWorker } from "./main/profile-sync/storage-revision-worker-reader.js";
import {
  ChromeProfileCookieSourceProvider,
  UfoProfileCookieSourceProvider,
} from "./main/profile-sync/source-providers.js";
import { ProfileAvatarStore } from "./main/profile-avatar-store.js";
import { ProfileCloneService } from "./main/profile-clone/service.js";
import {
  MacKeychainProvider,
  MockKeychainProvider,
} from "./main/chrome-import/keychain.js";
import { ClaudeSessionManager } from "./main/claude-chat/manager.js";
import { visibleSpaceIds } from "./main/preview-visibility.js";
import { bitmapHasVisualDetail } from "./main/preview-quality.js";
import { BROWSER_CHROME_HEIGHT } from "./main/shell-page-bounds.js";
import type { Rect } from "./main/types.js";
import {
  chromiumAcceptLanguages,
  reducedChromiumUserAgent,
} from "./main/chromium-identity.js";
import {
  isTemporaryProfileId,
  TEMPORARY_PROFILE_ID,
  temporaryPublicProfile,
  temporarySessionPartition,
} from "./main/temporary-profile.js";

const isTestApp =
  process.env.UFO_BROWSER_TEST_APP === "1" ||
  process.env.X_BROWSER_TEST_APP === "1";
let appIsQuitting = false;
let appQuitReady = false;
let beginAppShutdown: (() => Promise<void>) | undefined;
app.on("before-quit", (event) => {
  appIsQuitting = true;
  if (appQuitReady || !beginAppShutdown) return;
  event.preventDefault();
  void beginAppShutdown().finally(() => {
    appQuitReady = true;
    app.quit();
  });
});
app.on("web-contents-created", (_event, webContents) => {
  webContents.on("will-prevent-unload", (event) => {
    if (appIsQuitting) event.preventDefault();
  });
});
const projectRoot = app.getAppPath();
const testNamespace = String(process.env.X_BROWSER_TEST_NAMESPACE || "")
  .replace(/[^a-zA-Z0-9_-]/g, "")
  .slice(0, 64);
const requestedTestRoot = process.env.X_BROWSER_TEST_ROOT;
const explicitTestRoot =
  isTestApp && requestedTestRoot && isAbsolute(requestedTestRoot)
    ? resolve(requestedTestRoot)
    : undefined;
const testRoot =
  explicitTestRoot ??
  (testNamespace
    ? join(projectRoot, ".x-browser-test", "runs", testNamespace)
    : join(projectRoot, ".x-browser-test"));
if (isTestApp) app.setPath("userData", join(testRoot, "user-data"));

app.setName("UFO-Browser");
app.userAgentFallback = reducedChromiumUserAgent(process.versions.chrome);
app.commandLine.appendSwitch("lang", "zh-CN");
app.commandLine.appendSwitch("accept-lang", chromiumAcceptLanguages);
// Match Chromium's normal autoplay gate. Without this Electron starts a fresh
// AudioContext immediately, which is observably different from a regular
// browser page before the user interacts with it.
app.commandLine.appendSwitch(
  "autoplay-policy",
  "document-user-activation-required",
);
// Match Chromium's process isolation model so cross-site frames remain real
// OOPIF targets instead of being collapsed into the embedding renderer.
app.commandLine.appendSwitch("site-per-process");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(start)
    .catch((error) => {
      console.error("UFO-Browser failed to start", error);
      app.quit();
    });
}

async function start() {
  const traceStart = (stage: string) => {
    if (isTestApp) console.error(`[UFO-Browser start] ${stage}`);
  };
  traceStart("begin");
  const appIconPath = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(projectRoot, "resources/icon.png");
  if (process.platform === "darwin") app.dock?.setIcon(appIconPath);
  const renderer = (name: string) => join(projectRoot, "dist/renderer", name);
  const shellPreload = join(projectRoot, "dist/preload/shell.cjs");
  const pagePreload = join(projectRoot, "dist/preload/page.cjs");
  const requestedOverviewSpaceIdValue = Number(
    process.env.X_BROWSER_TEST_OVERVIEW_SPACE_ID || "",
  );
  const requestedOverviewSpaceId =
    Number.isSafeInteger(requestedOverviewSpaceIdValue) &&
    requestedOverviewSpaceIdValue > 0
      ? requestedOverviewSpaceIdValue
      : Number.NaN;

  const window = new BaseWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: "UFO-Browser",
    icon: appIconPath,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 22 },
    backgroundColor: "#f6f9f8",
  });

  const captureWindow = new BaseWindow({
    width: 1200,
    height: 790,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    focusable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    resizable: false,
  });
  captureWindow.setOpacity(0);
  captureWindow.setIgnoreMouseEvents(true);

  const shellPreferences = {
    preload: shellPreload,
    contextIsolation: true,
    nodeIntegration: false,
    // Hidden shell views have no useful animation or polling work. Let
    // Chromium throttle them just like normal background browser UI; visible
    // views are automatically restored to foreground cadence.
    backgroundThrottling: true,
    sandbox: true,
  };
  const chatView = new WebContentsView({ webPreferences: shellPreferences });
  const overviewView = new WebContentsView({ webPreferences: shellPreferences });
  const browserView = new WebContentsView({ webPreferences: shellPreferences });
  const overlayView = new WebContentsView({
    webPreferences: {
      ...shellPreferences,
      backgroundThrottling: true,
    },
  });
  for (const view of [chatView, overviewView, browserView]) {
    view.setBackgroundColor("#f7faf9");
  }
  overlayView.setBackgroundColor("#00000000");
  overlayView.setVisible(false);
  traceStart("shell-created");

  const userDataPath = app.getPath("userData");
  const nativeTransitionAddonPath = app.isPackaged
    ? join(
        process.resourcesPath,
        "app.asar.unpacked",
        "dist",
        "bin",
        "ufo-transition.node",
      )
    : join(projectRoot, "dist", "bin", "ufo-transition.node");
  const nativeTransition = new NativeSpaceTransition(
    window,
    join(userDataPath, "Transition Snapshots"),
    nativeTransitionAddonPath,
  );
  const nativeBrowserChromeAddonPath = app.isPackaged
    ? join(
        process.resourcesPath,
        "app.asar.unpacked",
        "dist",
        "bin",
        "ufo-browser-chrome.node",
      )
    : join(projectRoot, "dist", "bin", "ufo-browser-chrome.node");
  const nativeChrome = new NativeBrowserChrome(
    window,
    nativeBrowserChromeAddonPath,
  );
  const partitionsRoot = join(userDataPath, "Partitions");
  const profileAvatars = new ProfileAvatarStore(
    join(userDataPath, "Profile Avatars"),
  );
  const store = new BrowserStateStore(join(userDataPath, "browser-state.json"));
  const profiles = new BrowserProfileRegistry(join(userDataPath, "profiles.json"));
  await profiles.initialize();
  const pendingProfileCleanup = profiles.pendingPartitionCleanup();
  if (pendingProfileCleanup.length > 0) {
    await cleanupPendingProfilePartitions(partitionsRoot, pendingProfileCleanup);
    await profiles.completePartitionCleanup(pendingProfileCleanup);
  }
  await recoverChromeImportJobs(
    join(userDataPath, "Chrome Import", "jobs"),
    partitionsRoot,
    profiles.partitionIds(),
  );
  const keychainHelperPath = app.isPackaged
    ? join(
        process.resourcesPath,
        "app.asar.unpacked",
        "dist",
        "bin",
        "ufo-keychain-helper",
      )
    : join(projectRoot, "dist", "bin", "ufo-keychain-helper");
  const testSafeStorageSecret = process.env.X_BROWSER_TEST_CHROME_SAFE_STORAGE_SECRET;
  const chromeUserDataPath =
    isTestApp && process.env.X_BROWSER_TEST_CHROME_USER_DATA_PATH
      ? process.env.X_BROWSER_TEST_CHROME_USER_DATA_PATH
      : undefined;
  const chromeFixtureRelativePath = chromeUserDataPath
    ? relative(resolve(testRoot), resolve(chromeUserDataPath))
    : "";
  const chromeFixtureIsIsolated = Boolean(
    chromeFixtureRelativePath &&
      chromeFixtureRelativePath !== ".." &&
      !chromeFixtureRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(chromeFixtureRelativePath),
  );
  const chromeSourceAdapter =
    isTestApp &&
    chromeUserDataPath &&
    chromeFixtureIsIsolated &&
    process.env.X_BROWSER_TEST_CHROME_QUIT_MODE === "remove-isolated-lock"
      ? {
          ...createChromeStableSourceAdapter(chromeUserDataPath),
          quit: async () => {
            await rm(join(chromeUserDataPath, "SingletonLock"), {
              force: true,
            });
            return { done: true };
          },
        }
      : undefined;
  const keychain =
    isTestApp && testSafeStorageSecret
      ? new MockKeychainProvider(testSafeStorageSecret)
      : new MacKeychainProvider(keychainHelperPath);
  const resolvedChromeSourceAdapter =
    chromeSourceAdapter ?? createChromeStableSourceAdapter(chromeUserDataPath);
  const readChromeCookiesWorker = createChromeCookieWorkerReader(
    join(projectRoot, "dist", "main", "chrome-cookie-worker.js"),
    keychain,
  );
  const createProfileTarget = (profile: {
    id: string;
    partitionId: string;
  }) =>
    createElectronCookieWriteTarget({
      partitionsRoot,
      profileId: profile.id,
      partitionId: profile.partitionId,
      copiedStorage: [],
    });
  const profileSyncCheckpoints = new ProfileSyncCheckpointStore(
    join(userDataPath, "Profile Sync", "checkpoints"),
  );
  let prepareProfileStorage = (_profileId: string): Promise<unknown> =>
    Promise.resolve();
  const sourceProviders = [
    new ChromeProfileCookieSourceProvider(
      resolvedChromeSourceAdapter,
      readChromeCookiesWorker,
    ),
    new UfoProfileCookieSourceProvider(
      (profileId) => profiles.getOrThrow(profileId),
      createProfileTarget,
      partitionsRoot,
      (profileId) => prepareProfileStorage(profileId),
    ),
  ];
  const publishProfileSyncProgress = (status: unknown) => {
    if (!overviewView.webContents.isDestroyed()) {
      overviewView.webContents.send("x-browser:profile-sync-progress", status);
    }
  };
  const profileStorageSync = new ProfileStorageSyncService({
    profiles,
    checkpoints: profileSyncCheckpoints,
    sourceProviders,
    partitionsRoot,
    workRoot: join(userDataPath, "Profile Sync", "storage-work"),
    scanRevisions: createStorageRevisionWorker(
      join(
        projectRoot,
        "dist",
        "main",
        "profile-sync-storage-revision-worker.js",
      ),
    ),
    flushTarget: async (profileId) => {
      const target = await createProfileTarget(profiles.getOrThrow(profileId));
      try {
        await target.flush();
      } finally {
        await target.dispose();
      }
    },
    onProgress: publishProfileSyncProgress,
  });
  prepareProfileStorage = (profileId) =>
    profileStorageSync.prepareProfile(profileId);
  const profileSync = new ProfileSyncService({
    profiles,
    checkpoints: profileSyncCheckpoints,
    sourceProviders,
    createTarget: createProfileTarget,
    prepareTarget: (profileId) => profileStorageSync.prepareProfile(profileId),
    seedTarget: (profileId) => profileStorageSync.seedProfile(profileId),
    enableTarget: (profileId) =>
      profileStorageSync.rebaselineProfile(profileId),
    diffCookies: createProfileCookieDiffWorker(
      join(
        projectRoot,
        "dist",
        "main",
        "profile-sync-cookie-diff-worker.js",
      ),
    ),
    onProgress: publishProfileSyncProgress,
  });
  const profileClone = new ProfileCloneService({
    profiles,
    partitionsRoot,
    avatars: profileAvatars,
    sync: profileSync,
    createTarget: createProfileTarget,
  });
  const chromeImport = new ChromeLoginImportService({
    userDataPath,
    partitionsRoot,
    profiles,
    keychain,
    readCookies: readChromeCookiesWorker,
    targetChromiumVersion: process.versions.chrome,
    chromeUserDataPath,
    sourceAdapter: resolvedChromeSourceAdapter,
    preflightStorage: createChromeStoragePreflightWorker(
      join(projectRoot, "dist", "main", "chrome-storage-preflight-worker.js"),
      partitionsRoot,
    ),
    createTarget: (profileId, partitionId, copiedStorage, staticPreflight) =>
      createElectronCookieWriteTarget({
        partitionsRoot,
        profileId,
        partitionId,
        copiedStorage,
        staticPreflight,
      }),
    onProfileImported: async (profile, cookies, source) => {
      await profileAvatars
        .importFromPath(profile.id, source.avatarPath)
        .catch(() => false);
      await profileSync.seedProfile(profile.id, cookies);
    },
  });
  const manager = new TaskSpaceManager({
    store,
    profiles,
    partitionsRoot,
    pagePreload,
    captureWindow,
    beforeProfileSessionSetup: (profileId) =>
      profileStorageSync.prepareProfile(profileId),
    forcedPreviewSpaceId:
      isTestApp && Number.isSafeInteger(requestedOverviewSpaceId)
        ? requestedOverviewSpaceId
        : undefined,
    forceColdPreviewCaptureFailure:
      isTestApp && process.env.X_BROWSER_TEST_FAIL_COLD_PREVIEW === "1",
    publishPreviewFrame: ({ spaceId, revision, data }) => {
      if (overviewView.webContents.isDestroyed()) return;
      overviewView.webContents.send("x-browser:overview-preview-frame", {
        spaceId,
        revision,
        data,
      });
    },
  });
  await manager.initialize();
  await nativeTransition.prime(
    manager.listSpaces().slice(0, 6).map((space) => space.id),
  );
  traceStart("manager-initialized");
  if (manager.listSpaces().length === 0) {
    await manager.createSpace("Welcome Space", "user");
  }

  const leases = new SpaceLeaseRegistry();
  const snapshot = new SnapshotService(manager);
  const eventJournal = new SpaceEventJournal({
    directory: join(app.getPath("userData"), "Agent Events"),
  });
  await eventJournal.initialize();
  const agentTrace = new AgentTraceService(eventJournal, manager);
  const workflows = new WorkflowService(eventJournal, {
    directory: join(app.getPath("userData"), "Agent Workflows"),
  });
  await workflows.initialize();
  const profileRequests = new ProfileRequestService(manager, eventJournal);
  const broker = new CdpBroker(manager, leases, eventJournal);
  const socketPath = isTestApp
    ? join(testRoot, "x-browser.sock")
    : join(app.getPath("userData"), "ufo-browser.sock");
  const server = new AgentServer(
    socketPath,
    manager,
    leases,
    snapshot,
    broker,
    app.getVersion(),
    eventJournal,
    agentTrace,
    workflows,
    profileRequests,
  );
  const assistantWorkspace = join(app.getPath("userData"), "Assistant Workspace");
  const skillSource = app.isPackaged
    ? join(process.resourcesPath, "skills/ufo-browser")
    : join(projectRoot, "skills/ufo-browser");
  await mkdir(join(assistantWorkspace, ".claude/skills"), {
    recursive: true,
    mode: 0o700,
  });
  await cp(skillSource, join(assistantWorkspace, ".claude/skills/ufo-browser"), {
    recursive: true,
    force: true,
  });
  traceStart("skill-synced");
  const claude = new ClaudeSessionManager({
    claudePath:
      process.env.UFO_BROWSER_CLAUDE_PATH ||
      process.env.X_BROWSER_CLAUDE_PATH ||
      "claude",
    workspace: assistantWorkspace,
    cliDirectory: app.isPackaged
      ? join(process.resourcesPath, "app.asar.unpacked/dist/bin")
      : join(projectRoot, "dist/bin"),
    socketPath,
  });
  await claude.initialize();
  traceStart("chat-initialized");
  const presentation = new PresentationCoordinator(
    window,
    {
      chat: chatView,
      overview: overviewView,
      browser: browserView,
      overlay: overlayView,
    },
    manager,
    nativeTransition,
    nativeChrome,
  );
  nativeChrome.install((event) => {
    if (appIsQuitting) return;
    void handleNativeBrowserChromeEvent(
      event,
      manager,
      presentation,
      nativeChrome,
    ).catch(() => undefined);
  });
  const presentationSubscriptions = [
    manager.onActiveTabChanged((spaceId) => {
      const current = presentation.current();
      if (current.kind !== "space" || current.spaceId !== spaceId) return;
      return presentation.refreshSpace(spaceId).catch(() => undefined);
    }),
  ];
  presentationSubscriptions.push(
    manager.onAgentPointer((spaceId, pointer) =>
      presentation.showAgentPointer(spaceId, pointer),
    ),
  );
  presentationSubscriptions.push(
    manager.onBeforeSpaceClose(async (spaceId) => {
      const closing = manager.getSpace(spaceId);
      if (closing) {
        eventJournal.append({
          spaceId,
          tabId: closing.activeTabId,
          category: "lifecycle",
          type: "space.closing",
          data: { lifecycle: closing.lifecycle, profileMode: closing.profileMode },
        });
        if (closing.profileMode === "temporary") {
          await agentTrace.clearTemporary(spaceId);
        }
      }
      const current = presentation.current();
      if (current.kind === "space" && current.spaceId === spaceId) {
        await presentation.showOverview({ parkPrevious: false });
      }
    }),
  );

  const shellIds = new Set([
    chatView.webContents.id,
    overviewView.webContents.id,
    browserView.webContents.id,
    overlayView.webContents.id,
  ]);
  registerIpc({
    manager,
    presentation,
    leases,
    shellIds,
    chatView,
    overviewView,
    browserView,
    nativeChrome,
    claude,
    profiles,
    chromeImport,
    profileSync,
    profileStorageSync,
    profileClone,
    profileAvatars,
    eventJournal,
    agentTrace,
  });
  traceStart("ipc-registered");
  const unsubscribeClaude = claude.onEvent((event) => {
    if (appIsQuitting || chatView.webContents.isDestroyed()) return;
    chatView.webContents.send("x-browser:chat-event", event);
  });

  const publish = () => {
    if (
      appIsQuitting ||
      window.isDestroyed() ||
      overviewView.webContents.isDestroyed()
    ) {
      return;
    }
    const spaces = manager.listSpaces();
    overviewView.webContents.send("x-browser:spaces-changed", spaces);
    const current = presentation.current();
    if (current.kind === "space") {
      if (!manager.getSpace(current.spaceId)) {
        void presentation.showOverview({ parkPrevious: false }).catch(
          () => undefined,
        );
        return;
      }
      browserView.webContents.send(
        "x-browser:browser-state",
        manager.navigationState(current.spaceId),
      );
      nativeChrome.update(manager.navigationState(current.spaceId));
      presentation.scheduleSnapshotRefresh(current.spaceId);
    }
    presentation.refreshControlOverlay();
  };
  presentationSubscriptions.push(manager.onChanged(publish));
  presentationSubscriptions.push(manager.onControlChanged(publish));

  await Promise.all([
    chatView.webContents.loadFile(renderer("chat.html")),
    overviewView.webContents.loadFile(renderer("overview.html")),
    browserView.webContents.loadFile(renderer("browser.html")),
    overlayView.webContents.loadFile(renderer("agent-overlay.html")),
  ]);
  profileSync.start();
  traceStart("shell-loaded");
  await presentation.showOverview();
  traceStart("overview-presented");
  const requestedTestSpaceId = Number(
    process.env.X_BROWSER_TEST_SPACE_ID || "",
  );
  if (
    isTestApp &&
    Number.isSafeInteger(requestedTestSpaceId) &&
    manager.getSpace(requestedTestSpaceId)
  ) {
    await presentation.showSpace(requestedTestSpaceId);
    browserView.webContents.send(
      "x-browser:browser-state",
      manager.navigationState(requestedTestSpaceId),
    );
    nativeChrome.update(manager.navigationState(requestedTestSpaceId));
    traceStart("test-space-presented");
  }
  publish();
  window.show();
  presentation.syncWindowState();
  window.focus();
  app.focus({ steal: true });
  if (presentation.current().kind === "overview") {
    // Do not make cold-start hydration depend exclusively on a renderer RAF,
    // IntersectionObserver entry or timer firing after the native view swap.
    // The first eight records are the bounded top-of-grid candidates; the
    // renderer replaces this conservative seed with exact card rectangles as
    // soon as scrolling/layout observation is available.
    manager.setVisiblePreviewSpaces(
      manager.listSpaces().slice(0, 6).map((space) => space.id),
    );
  }
  traceStart("window-shown");

  if (isTestApp && process.env.X_BROWSER_TEST_RETURN_OVERVIEW === "1") {
    setTimeout(() => {
      void browserView.webContents.executeJavaScript(
        "document.querySelector('#spaces-button')?.click()",
        true,
      );
    }, 2200);
  }

  if (
    isTestApp &&
    Number.isSafeInteger(requestedOverviewSpaceId) &&
    manager.getSpace(requestedOverviewSpaceId)
  ) {
    // Forced-card verifiers opt out of renderer visibility timing entirely.
    // Publish the requested card synchronously so a concurrently focused
    // development App cannot delay the cold-preview queue.
    manager.setVisiblePreviewSpaces([requestedOverviewSpaceId]);
    setTimeout(() => {
      void overviewView.webContents
        .executeJavaScript(
          `document.querySelector('[data-space-id="${requestedOverviewSpaceId}"]')?.scrollIntoView({ block: 'start' })`,
          true,
        )
        .finally(() => {
          setTimeout(() => {
            manager.setVisiblePreviewSpaces([requestedOverviewSpaceId]);
          }, 180);
        });
      // The dynamic-preview audit targets a card that can be far below the first
      // viewport. DOM scrolling is still exercised above, while the explicit
      // visibility publication removes timer/layout nondeterminism from the
      // bounded snapshot lifecycle assertion.
    }, 1200);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_OVERVIEW_STRESS_SCROLL === "1") {
    setTimeout(() => {
      void overviewView.webContents.executeJavaScript(
        `(() => {
          const points = [0, .14, .28, .42, .56, .70, .84, 1];
          let index = 0;
          const advance = () => {
            const scroller = document.body;
            const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            scroller.scrollTo({ top: Math.round(max * points[index]), behavior: 'instant' });
            index += 1;
            if (index >= points.length) clearInterval(timer);
          };
          advance();
          const timer = setInterval(advance, 2400);
          return true;
        })()`,
        true,
      );
    }, 4500);
  }

  if (isTestApp) {
    await mkdir(testRoot, { recursive: true });
    await writeFile(join(testRoot, "socket-path"), `${socketPath}\n`);
    await writeFile(join(testRoot, "pid"), `${process.pid}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await writeFile(
      join(testRoot, "preview-main-initial.json"),
      `${JSON.stringify(
        testPreviewDiagnostics(manager, {
          window,
          captureWindow,
          presentation,
          chatView,
          overviewView,
          browserView,
          overlayView,
        }),
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(testRoot, "view-state.json"),
      `${JSON.stringify(
        {
          window: {
            bounds: window.getBounds(),
            contentSize: window.getContentSize(),
            visible: window.isVisible(),
            focused: window.isFocused(),
          },
          rootChildren: window.contentView.children.map((child) => ({
            bounds: child.getBounds(),
            visible: child.getVisible(),
          })),
          chat: {
            bounds: chatView.getBounds(),
            visible: chatView.getVisible(),
            url: chatView.webContents.getURL(),
          },
          overview: {
            bounds: overviewView.getBounds(),
            visible: overviewView.getVisible(),
            url: overviewView.webContents.getURL(),
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  await server.listen();
  traceStart("agent-server-listening");

  if (isTestApp && process.env.X_BROWSER_TEST_APP_QUIT_AUDIT === "1") {
    setTimeout(() => {
      void runAppQuitAudit({ testRoot, manager, presentation, overlayView }).catch(
        async (error) => {
          await writeFile(
            join(testRoot, "app-quit-audit.json"),
            `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
          ).catch(() => undefined);
          app.quit();
        },
      );
    }, 350);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_TEMPORARY_PROFILE_AUDIT === "1") {
    setTimeout(() => {
      void runTemporaryProfileAudit({
        testRoot,
        userDataPath,
        manager,
        profiles,
      }).catch(async (error) => {
        await writeFile(
          join(testRoot, "temporary-profile-audit.json"),
          `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
        ).catch(() => undefined);
      });
    }, 500);
  }

  if (
    isTestApp &&
    process.env.X_BROWSER_TEST_TEMPORARY_PROFILE_RESTORE_AUDIT === "1"
  ) {
    setTimeout(() => {
      void runTemporaryProfileRestoreAudit({ testRoot, manager }).catch(
        async (error) => {
          await writeFile(
            join(testRoot, "temporary-profile-restore-audit.json"),
            `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
          ).catch(() => undefined);
        },
      );
    }, 350);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_WARM_ENTRY_AUDIT === "1") {
    setTimeout(() => {
      void runWarmEntryAudit({ testRoot, manager, presentation }).catch(
        async (error) => {
          await writeFile(
            join(testRoot, "warm-entry-audit.json"),
            `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
          ).catch(() => undefined);
        },
      );
    }, 350);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_INTERACTION_AUDIT === "1") {
    setTimeout(() => {
      void runBrowserInteractionAudit({
        testRoot,
        window,
        manager,
        presentation,
        browserView,
        nativeChrome,
      }).catch(async (error) => {
        await writeFile(
          join(testRoot, "interaction-audit.json"),
          `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
        ).catch(() => undefined);
      });
    }, 500);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_SPACE_UI_AUDIT === "1") {
    setTimeout(() => {
      void runSpaceUiAudit({
        testRoot,
        manager,
        profiles,
        presentation,
        overviewView,
        eventJournal,
      }).catch(
        async (error) => {
          await writeFile(
            join(testRoot, "space-ui-audit.json"),
            `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
          ).catch(() => undefined);
        },
      );
    }, 500);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_CHROME_IMPORT_UI_AUDIT === "1") {
    setTimeout(() => {
      void runChromeImportUiAudit({
        testRoot,
        userDataPath,
        manager,
        profiles,
        overviewView,
      }).catch(async (error) => {
        await writeFile(
          join(testRoot, "chrome-import-ui-audit.json"),
          `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
        ).catch(() => undefined);
      });
    }, 650);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_CHROME_IMPORT_RESTART_AUDIT === "1") {
    setTimeout(() => {
      void runChromeImportRestartAudit({
        testRoot,
        userDataPath,
        manager,
        profiles,
        overviewView,
      }).catch(async (error) => {
        await writeFile(
          join(testRoot, "chrome-import-restart-audit.json"),
          `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
        ).catch(() => undefined);
      });
    }, 650);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_PROFILE_SYNC_AUDIT === "1") {
    setTimeout(() => {
      void runProfileSyncAudit({
        testRoot,
        userDataPath,
        profiles,
        profileSync,
        profileStorageSync,
        overviewView,
      }).catch(async (error) => {
        await writeFile(
          join(testRoot, "profile-sync-audit.json"),
          `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
        ).catch(() => undefined);
      });
    }, 650);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_CHROME_IMPORT_ROLLBACK_AUDIT === "1") {
    setTimeout(() => {
      void runChromeImportRollbackAudit({
        testRoot,
        profiles,
        overviewView,
      }).catch(async (error) => {
        await writeFile(
          join(testRoot, "chrome-import-rollback-audit.json"),
          `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
        ).catch(() => undefined);
      });
    }, 650);
  }

  if (
    isTestApp &&
    process.env.X_BROWSER_TEST_CHROME_IMPORT_ROLLBACK_RECOVERY_AUDIT === "1"
  ) {
    setTimeout(() => {
      void runChromeImportRollbackRecoveryAudit({
        testRoot,
        userDataPath,
        profiles,
      }).catch(async (error) => {
        await writeFile(
          join(testRoot, "chrome-import-rollback-recovery-audit.json"),
          `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
        ).catch(() => undefined);
      });
    }, 650);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_CONTROL_UI_AUDIT === "1") {
    setTimeout(() => {
      void runControlUiAudit({
        testRoot,
        window,
        manager,
        presentation,
        browserView,
        nativeChrome,
        overviewView,
        overlayView,
      }).catch(async (error) => {
        await writeFile(
          join(testRoot, "control-ui-audit.json"),
          `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
        ).catch(() => undefined);
      });
    }, 500);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_WINDOW_LIFECYCLE_AUDIT === "1") {
    setTimeout(() => {
      void runWindowLifecycleAudit({
        testRoot,
        window,
        manager,
        presentation,
        overviewView,
      }).catch(async (error) => {
        await writeFile(
          join(testRoot, "window-lifecycle-audit.json"),
          `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
        ).catch(() => undefined);
      });
    }, 1800);
  }

  let testDiagnosticsTimer: ReturnType<typeof setInterval> | undefined;
  if (isTestApp) {
    testDiagnosticsTimer = setInterval(() => {
      void writeFile(
        join(testRoot, "preview-main-live.json"),
        `${JSON.stringify(
          testPreviewDiagnostics(manager, {
            window,
            captureWindow,
            presentation,
            chatView,
            overviewView,
            browserView,
            overlayView,
          }),
          null,
          2,
        )}\n`,
      ).catch(() => undefined);
    }, 350);
    setTimeout(() => {
      void captureVisibleTestViews({
        testRoot,
        manager,
        chatView,
        overviewView,
        browserView,
      }).catch(() => undefined);
    }, 2800);
    setTimeout(() => {
      void captureVisibleTestViews(
        {
          testRoot,
          manager,
          chatView,
          overviewView,
          browserView,
        },
        "-settled",
      ).catch(() => undefined);
    }, 12000);
  }

  const revealWindow = () => {
    if (window.isMinimized()) window.restore();
    window.show();
    presentation.syncWindowState();
    window.focus();
    app.focus({ steal: true });
  };
  app.on("second-instance", revealWindow);
  app.on("activate", revealWindow);
  let presentationDetached = false;
  const detachPresentation = () => {
    if (presentationDetached) return;
    presentationDetached = true;
    presentation.dispose();
    for (const unsubscribe of presentationSubscriptions) unsubscribe();
    unsubscribeClaude();
    app.removeListener("second-instance", revealWindow);
    app.removeListener("activate", revealWindow);
  };
  let shutdownPromise: Promise<void> | undefined;
  beginAppShutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    // Stop every state-to-view callback before the second app.quit() is allowed
    // to destroy BaseWindow. WebContents emit final lifecycle events during
    // native teardown; those events may still update TaskSpaceManager, but may
    // no longer touch AppKit views or their destroyed contentView root.
    detachPresentation();
    manager.setOverviewPreviewActive(false);
    claude.stop();
    shutdownPromise = server
      .close()
      .catch(() => undefined)
      .then(() => profileSync.close().catch(() => undefined))
      .then(() =>
        settleWithin(
          Promise.allSettled([eventJournal.flush(), workflows.flush()]),
          1_500,
        ),
      )
      .then(() => manager.flushState().catch(() => undefined))
      .then(() => {
        if (!captureWindow.isDestroyed()) captureWindow.close();
      });
    return shutdownPromise;
  };
  window.on("close", (event) => {
    if (process.platform !== "darwin" || appIsQuitting) return;
    event.preventDefault();
    window.hide();
    // BaseWindow's native `hide` event may be delivered after close() has
    // returned. Stop Overview capture synchronously so a hidden App never
    // keeps preview renderers or screencasts active while preserving the
    // window and its renderer state for the next activation.
    manager.setOverviewPreviewActive(false);
  });
  window.on("closed", () => {
    detachPresentation();
    if (testDiagnosticsTimer) clearInterval(testDiagnosticsTimer);
  });
}

async function runTemporaryProfileAudit(context: {
  testRoot: string;
  userDataPath: string;
  manager: TaskSpaceManager;
  profiles: BrowserProfileRegistry;
}) {
  const { testRoot, userDataPath, manager, profiles } = context;
  const origin = String(process.env.X_BROWSER_TEST_STORAGE_ORIGIN || "");
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(origin)) {
    throw new Error("temporary Profile audit requires a trusted local origin");
  }

  const human = await manager.createSpace(
    "Human Temporary",
    "user",
    "temporary",
  );
  const agentA = await manager.createSpace(
    "Agent Temporary A",
    "agent",
    "Temporary",
  );
  const agentB = await manager.createSpace(
    "Agent Temporary B",
    "agent",
    "temporary",
  );
  const defaultProfile = profiles.getDefault();
  const persistentA = await manager.createSpace(
    "Persistent Shared A",
    "user",
    defaultProfile.id,
  );
  const persistentB = await manager.createSpace(
    "Persistent Shared B",
    "agent",
    defaultProfile.id,
  );

  const views = new Map<number, WebContentsView>();
  for (const space of [human, agentA, agentB, persistentA, persistentB]) {
    const view = await manager.activeViewForPresentation(space.id);
    await view.webContents.loadURL(origin);
    views.set(space.id, view);
  }

  const humanView = views.get(human.id)!;
  const agentAView = views.get(agentA.id)!;
  const agentBView = views.get(agentB.id)!;
  const persistentAView = views.get(persistentA.id)!;
  const persistentBView = views.get(persistentB.id)!;
  await writeIsolationStorage(humanView, "human");
  const agentBeforeWrite = await readIsolationStorage(agentAView);
  await writeIsolationStorage(agentAView, "agent-a");
  const secondAgentBeforeWrite = await readIsolationStorage(agentBView);
  const humanAfterAgentWrite = await readIsolationStorage(humanView);
  await writeIsolationStorage(persistentAView, "persistent-shared");
  const persistentShared = await readIsolationStorage(persistentBView);

  const temporarySpaces = [human, agentA, agentB];
  const temporaryPartitions = temporarySpaces.map((space) =>
    temporarySessionPartition(String(space.sessionScopeId || "")),
  );
  const partitionEvidence = temporarySpaces.map((space, index) => {
    const view = views.get(space.id)!;
    const chromiumSession = session.fromPartition(temporaryPartitions[index]);
    return {
      id: space.id,
      profileMode: space.profileMode,
      profileId: space.profileId,
      scopePresent: Boolean(space.sessionScopeId),
      partition: temporaryPartitions[index],
      isPersistent: chromiumSession.isPersistent(),
      ownsViewSession: view.webContents.session === chromiumSession,
    };
  });
  const persistentPartition = `persist:${defaultProfile.partitionId}`;
  const persistentSession = session.fromPartition(persistentPartition);
  const persistentEvidence = {
    partition: persistentPartition,
    isPersistent: persistentSession.isPersistent(),
    firstOwnsSession:
      persistentAView.webContents.session === persistentSession,
    secondOwnsSession:
      persistentBView.webContents.session === persistentSession,
  };

  const agentAPartition = temporaryPartitions[1];
  await manager.closeSpace(agentA.id);
  const probe = new WebContentsView({
    webPreferences: {
      partition: agentAPartition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await probe.webContents.loadURL(origin);
  const closedSessionStorage = await readIsolationStorage(probe);
  probe.webContents.close();

  await manager.flushState();
  const browserState = JSON.parse(
    await readFile(join(userDataPath, "browser-state.json"), "utf8"),
  );
  const profileState = JSON.parse(
    await readFile(join(userDataPath, "profiles.json"), "utf8"),
  );
  const persistedIds = new Set<number>(
    browserState.spaces.map((space: { id: number }) => Number(space.id)),
  );
  const registryProfileIds = profileState.profiles.map(
    (profile: { id: string }) => profile.id,
  );
  const liveTemporaryIds = [human.id, agentB.id];
  const ok =
    agentBeforeWrite.cookie === "" &&
    agentBeforeWrite.localStorage === null &&
    agentBeforeWrite.indexedDb === null &&
    secondAgentBeforeWrite.cookie === "" &&
    secondAgentBeforeWrite.localStorage === null &&
    secondAgentBeforeWrite.indexedDb === null &&
    humanAfterAgentWrite.cookie.includes("ufo_isolation=human") &&
    humanAfterAgentWrite.localStorage === "human" &&
    humanAfterAgentWrite.indexedDb === "human" &&
    persistentShared.cookie.includes("ufo_isolation=persistent-shared") &&
    persistentShared.localStorage === "persistent-shared" &&
    persistentShared.indexedDb === "persistent-shared" &&
    new Set(temporaryPartitions).size === temporaryPartitions.length &&
    partitionEvidence.every(
      (entry) =>
        entry.profileMode === "temporary" &&
        entry.profileId === "temporary" &&
        entry.scopePresent &&
        entry.isPersistent === false &&
        entry.ownsViewSession,
    ) &&
    persistentEvidence.isPersistent === true &&
    persistentEvidence.firstOwnsSession &&
    persistentEvidence.secondOwnsSession &&
    closedSessionStorage.cookie === "" &&
    closedSessionStorage.localStorage === null &&
    closedSessionStorage.indexedDb === null &&
    liveTemporaryIds.every((id) => !persistedIds.has(id)) &&
    persistedIds.has(persistentA.id) &&
    persistedIds.has(persistentB.id) &&
    !registryProfileIds.includes("temporary");

  await writeFile(
    join(testRoot, "temporary-profile-audit.json"),
    `${JSON.stringify(
      {
        ok,
        spaces: {
          human: { id: human.id, profileMode: human.profileMode },
          agentA: { id: agentA.id, profileMode: agentA.profileMode },
          agentB: { id: agentB.id, profileMode: agentB.profileMode },
          persistentA: { id: persistentA.id, profileMode: persistentA.profileMode },
          persistentB: { id: persistentB.id, profileMode: persistentB.profileMode },
        },
        isolatedReads: {
          agentBeforeWrite,
          secondAgentBeforeWrite,
          humanAfterAgentWrite,
        },
        persistentShared,
        closedSessionStorage,
        partitionEvidence,
        persistentEvidence,
        persistedSpaceIds: [...persistedIds],
        registryProfileIds,
      },
      null,
      2,
    )}\n`,
  );
}

async function runTemporaryProfileRestoreAudit(context: {
  testRoot: string;
  manager: TaskSpaceManager;
}) {
  const spaces = context.manager.listSpaces();
  const names = spaces.map((space) => space.name);
  const ok =
    names.includes("Persistent Shared A") &&
    names.includes("Persistent Shared B") &&
    !names.includes("Human Temporary") &&
    !names.includes("Agent Temporary A") &&
    !names.includes("Agent Temporary B") &&
    !names.includes("CLI Temporary") &&
    spaces.every((space) => space.profileMode === "persistent");
  await writeFile(
    join(context.testRoot, "temporary-profile-restore-audit.json"),
    `${JSON.stringify(
      {
        ok,
        spaces: spaces.map((space) => ({
          id: space.id,
          name: space.name,
          profileId: space.profileId,
          profileMode: space.profileMode,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

async function writeIsolationStorage(view: WebContentsView, value: string) {
  await view.webContents.executeJavaScript(
    `(() => new Promise((resolve, reject) => {
      document.cookie = ${JSON.stringify(`ufo_isolation=${value}; Path=/; SameSite=Lax`)};
      localStorage.setItem('ufo-isolation', ${JSON.stringify(value)});
      const request = indexedDB.open('ufo-isolation', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('values');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('values', 'readwrite');
        transaction.objectStore('values').put(${JSON.stringify(value)}, 'current');
        transaction.oncomplete = () => { database.close(); resolve(true); };
        transaction.onerror = () => reject(transaction.error);
      };
    }))()`,
    true,
  );
}

async function readIsolationStorage(view: WebContentsView) {
  return view.webContents.executeJavaScript(
    `(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('ufo-isolation', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('values');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('values', 'readonly');
        const read = transaction.objectStore('values').get('current');
        read.onsuccess = () => {
          const result = {
            cookie: document.cookie,
            localStorage: localStorage.getItem('ufo-isolation'),
            indexedDb: read.result ?? null,
          };
          database.close();
          resolve(result);
        };
        read.onerror = () => reject(read.error);
      };
    }))()`,
    true,
  );
}

async function runWarmEntryAudit(context: {
  testRoot: string;
  manager: TaskSpaceManager;
  presentation: PresentationCoordinator;
}) {
  const { testRoot, manager, presentation } = context;
  const spaces = manager
    .listSpaces()
    .filter(
      (space) =>
        space.ownership === "user" && space.lifecycle === "active",
    )
    .slice(0, 8);
  if (spaces.length < 2) {
    throw new Error("warm entry audit requires at least two user Spaces");
  }
  await waitUntil(() => {
    const state = manager.previewDiagnostics();
    return spaces.every((space) => {
      const targetId = space.activeTabId;
      const runtime = state.runtimes.find(
        (candidate) => candidate.targetId === targetId,
      );
      return (
        runtime?.runtime === true &&
        runtime.loaded === true &&
        state.parkedRestoreTargets.includes(targetId)
      );
    });
  }, 9_000);

  const targetSpace = spaces[Math.min(1, spaces.length - 1)];
  const targetId = targetSpace.activeTabId;
  const targetView = manager.getView(targetId);
  if (!targetView) throw new Error("warm entry target renderer is missing");
  const before = manager.previewDiagnostics();
  const webContentsId = targetView.webContents.id;
  const enteredAt = Date.now();
  await presentation.showSpace(targetSpace.id);
  const entryElapsedMs = Date.now() - enteredAt;
  const afterView = manager.getView(targetId);
  const after = manager.previewDiagnostics();
  const roundTrips: Array<{
    cycle: number;
    entryElapsedMs: number;
    frameVisual: boolean;
    lowFrequencyUpdated: boolean;
    continuousPreview: boolean;
    sameWebContents: boolean;
  }> = [];
  const roundTripCount = Math.max(
    1,
    Number.parseInt(process.env.UFO_WARM_ENTRY_ROUND_TRIPS || "12", 10) || 12,
  );
  const idleEvery = Math.max(
    1,
    Number.parseInt(process.env.UFO_WARM_ENTRY_IDLE_EVERY || "3", 10) || 3,
  );
  const idleMs = Math.max(
    0,
    Number.parseInt(process.env.UFO_WARM_ENTRY_IDLE_MS || "1500", 10) || 0,
  );
  for (let cycle = 0; cycle < roundTripCount; cycle++) {
    const cycleStartedAt = Date.now();
    if (cycle > 0) await presentation.showSpace(targetSpace.id);
    const cycleView = manager.getView(targetId);
    if (!cycleView) throw new Error("round-trip renderer is missing");
    const frame = await cycleView.webContents.capturePage();
    const size = frame.getSize();
    const frameVisual =
      !frame.isEmpty() &&
      bitmapHasVisualDetail(frame.toBitmap(), size.width, size.height);
    await presentation.showOverview();
    manager.setVisiblePreviewSpaces([targetSpace.id]);
    const revisionBefore = Number(
      manager.previewDiagnostics().publishedRevision[targetSpace.id] ?? 0,
    );
    const effectiveDueAt = Number(
      manager.previewDiagnostics().effectiveDueAt[targetSpace.id] ?? Date.now(),
    );
    const refreshTimeoutMs = Math.max(
      5_500,
      effectiveDueAt - Date.now() + 2_000,
    );
    await waitUntil(() => {
      const state = manager.previewDiagnostics();
      return (
        state.screencast == null &&
        Number(state.publishedRevision[targetSpace.id] ?? 0) > revisionBefore
      );
    }, refreshTimeoutMs);
    const preview = manager.previewDiagnostics();
    const revisionAfter = Number(
      preview.publishedRevision[targetSpace.id] ?? 0,
    );
    roundTrips.push({
      cycle: cycle + 1,
      entryElapsedMs: Date.now() - cycleStartedAt,
      frameVisual,
      lowFrequencyUpdated: revisionAfter > revisionBefore,
      continuousPreview: preview.screencast !== null,
      sameWebContents: manager.getView(targetId)?.webContents.id === webContentsId,
    });
    await new Promise((resolve) =>
      setTimeout(resolve, (cycle + 1) % idleEvery === 0 ? idleMs : 120),
    );
  }
  const otherTargets = spaces
    .map((space) => space.activeTabId)
    .filter((candidate) => candidate !== targetId);
  const result = {
    ok:
      afterView?.webContents.id === webContentsId &&
      afterView.webContents.isLoading() === false &&
      entryElapsedMs < 400 &&
      roundTrips.every(
        (cycle) =>
          cycle.frameVisual &&
          cycle.lowFrequencyUpdated &&
          !cycle.continuousPreview &&
          cycle.sameWebContents,
      ) &&
      after.presentedTargetId === targetId &&
      after.runtimes.find((runtime) => runtime.targetId === targetId)
        ?.backgroundSurface === false &&
      otherTargets.every((candidate) =>
        after.parkedRestoreTargets.includes(candidate),
      ),
    entryElapsedMs,
    targetSpaceId: targetSpace.id,
    targetId,
    sameWebContents: afterView?.webContents.id === webContentsId,
    loadingAfterEntry: afterView?.webContents.isLoading() ?? true,
    beforeRuntimeCount: before.runtimes.filter((runtime) => runtime.runtime)
      .length,
    beforeParkedTargets: before.parkedRestoreTargets,
    afterParkedTargets: after.parkedRestoreTargets,
    presentedTargetId: after.presentedTargetId,
    roundTrips,
  };
  await writeFile(
    join(testRoot, "warm-entry-audit.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

async function runAppQuitAudit(context: {
  testRoot: string;
  manager: TaskSpaceManager;
  presentation: PresentationCoordinator;
  overlayView: WebContentsView;
}) {
  const { testRoot, manager, presentation, overlayView } = context;
  // Keep the control overlay attached while quitting. This reproduces the
  // teardown race where a late manager notification previously attempted to
  // remove the overlay from an already-destroyed BaseWindow contentView.
  const space = await manager.createSpace("Quit Agent Space", "agent");
  const tab = await manager.createTab(
    space.id,
    "data:text/html,<title>Quit%20Guard</title><main>quit%20guard</main>",
  );
  await presentation.showSpace(space.id);
  if (!overlayView.getVisible()) {
    throw new Error("quit audit Agent overlay was not attached");
  }
  const view = manager.getView(tab.targetId);
  if (!view) throw new Error("quit audit page was not created");
  await view.webContents.executeJavaScript(
    `window.addEventListener('beforeunload', event => {
      event.preventDefault();
      event.returnValue = 'quit guard';
    }); true`,
    true,
  );
  await writeFile(
    join(testRoot, "app-quit-audit.json"),
    `${JSON.stringify(
      {
        ok: true,
        armed: true,
        overlayVisible: overlayView.getVisible(),
        spaceId: space.id,
        webContentsId: view.webContents.id,
      },
      null,
      2,
    )}\n`,
  );
  setImmediate(() => app.quit());
}

async function runWindowLifecycleAudit(context: {
  testRoot: string;
  window: BaseWindow;
  manager: TaskSpaceManager;
  presentation: PresentationCoordinator;
  overviewView: WebContentsView;
}) {
  const { testRoot, window, manager, presentation, overviewView } = context;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const lifecycleToken = `overview-${Date.now()}`;
  const beforeDom = await overviewView.webContents.executeJavaScript(
    `(() => {
      document.body.dataset.lifecycleToken = ${JSON.stringify(lifecycleToken)};
      return {
        token: document.body.dataset.lifecycleToken,
        frames: Number(document.body.dataset.previewFrames || 0),
        ready: document.querySelectorAll('.preview-canvas.ready').length,
      };
    })()`,
    true,
  );
  const beforeDiagnostics = manager.previewDiagnostics();
  const before = {
    visible: window.isVisible(),
    overviewWebContentsId: overviewView.webContents.id,
    presentation: presentation.current(),
    cacheEntries: beforeDiagnostics.cacheBudget.entries,
    runtimeIds: beforeDiagnostics.runtimes
      .filter((runtime) => runtime.runtime)
      .map((runtime) => runtime.webContentsId)
      .filter(Boolean),
    dom: beforeDom,
  };

  window.close();
  await wait(240);
  const hidden = {
    visible: window.isVisible(),
    destroyed: overviewView.webContents.isDestroyed(),
    previewActive: manager.previewDiagnostics().active,
  };

  app.emit("activate");
  await wait(320);
  const afterDom = await overviewView.webContents.executeJavaScript(
    `(() => ({
      token: document.body.dataset.lifecycleToken || '',
      frames: Number(document.body.dataset.previewFrames || 0),
      ready: document.querySelectorAll('.preview-canvas.ready').length,
    }))()`,
    true,
  );
  const afterDiagnostics = manager.previewDiagnostics();
  const after = {
    visible: window.isVisible(),
    overviewWebContentsId: overviewView.webContents.id,
    presentation: presentation.current(),
    cacheEntries: afterDiagnostics.cacheBudget.entries,
    dom: afterDom,
  };
  const ok =
    before.visible === true &&
    hidden.visible === false &&
    hidden.destroyed === false &&
    hidden.previewActive === false &&
    after.visible === true &&
    after.overviewWebContentsId === before.overviewWebContentsId &&
    after.dom.token === lifecycleToken &&
    JSON.stringify(after.presentation) === JSON.stringify(before.presentation) &&
    after.cacheEntries >= before.cacheEntries;
  await writeFile(
    join(testRoot, "window-lifecycle-audit.json"),
    `${JSON.stringify({ ok, before, hidden, after }, null, 2)}\n`,
  );
}

type IpcContext = {
  manager: TaskSpaceManager;
  presentation: PresentationCoordinator;
  leases: SpaceLeaseRegistry;
  shellIds: Set<number>;
  chatView: WebContentsView;
  overviewView: WebContentsView;
  browserView: WebContentsView;
  nativeChrome: NativeBrowserChrome;
  claude: ClaudeSessionManager;
  profiles: BrowserProfileRegistry;
  chromeImport: ChromeLoginImportService;
  profileSync: ProfileSyncService;
  profileStorageSync: ProfileStorageSyncService;
  profileClone: ProfileCloneService;
  profileAvatars: ProfileAvatarStore;
  eventJournal: SpaceEventJournal;
  agentTrace: AgentTraceService;
};

function registerIpc(context: IpcContext) {
  const {
    manager,
    presentation,
    leases,
    shellIds,
    overviewView,
    browserView,
    nativeChrome,
    profiles,
    chromeImport,
    profileSync,
    profileStorageSync,
    profileClone,
    profileAvatars,
    eventJournal,
    agentTrace,
  } = context;
  const shell = <T extends unknown[]>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: T) => unknown,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!shellIds.has(event.sender.id)) throw new Error("untrusted shell sender");
      return handler(event, ...(args as T));
    });
  };

  shell("x-browser:overview:list", () => manager.listSpaces());
  shell("x-browser:overview:trace", (_event, spaceId: number, options?: unknown) => {
    const id = assertSpaceId(spaceId);
    manager.getSpaceOrThrow(id);
    return agentTrace.list(id, overviewTraceOptions(options));
  });
  shell("x-browser:overview:trace-screenshot", async (
    _event,
    spaceId: number,
    sequence: number,
  ) => {
    const id = assertSpaceId(spaceId);
    manager.getSpaceOrThrow(id);
    return agentTrace.screenshot(id, Number(sequence));
  });
  shell("x-browser:overview:events", (_event, spaceId: number, options?: unknown) => {
    const id = assertSpaceId(spaceId);
    manager.getSpaceOrThrow(id);
    return eventJournal.list(id, overviewTraceOptions(options));
  });
  shell("x-browser:app:info", () => ({
    name: app.getName(),
    version: app.getVersion(),
  }));
  shell("x-browser:profiles:list", async () => {
    const persistentProfiles = await Promise.all(
      profiles.listPublic().map(async (profile) => ({
        ...profile,
        avatarDataUrl: await profileAvatars.dataUrl(profile.id),
        syncStatus: profileSync.status(profile.id),
      })),
    );
    return [temporaryPublicProfile(), ...persistentProfiles];
  });
  shell("x-browser:profiles:set-default", async (_event, profileId: string) => {
    const id = String(profileId);
    if (isTemporaryProfileId(id)) {
      throw new Error("temporary-profile-cannot-be-default");
    }
    await profiles.setDefault(id);
    profileSync.notifyProfileActive(id);
  });
  shell("x-browser:profiles:remove", async (_event, profileId: string) => {
    const id = String(profileId);
    if (manager.listSpaces().some((space) => space.profileId === id)) {
      throw new Error("profile-in-use");
    }
    const removed = await profiles.remove(id);
    await profileSync.removeProfile(id);
    profileStorageSync.forgetProfile(id);
    await profileAvatars.remove(id);
    return removed;
  });
  shell(
    "x-browser:profiles:clone-ufo",
    (
      _event,
      sourceProfileId: string,
      name: string,
      makeDefault: boolean,
      loginSyncEnabled: boolean,
    ) =>
      profileClone.cloneUfoProfile({
        sourceProfileId: String(sourceProfileId),
        name: String(name || ""),
        makeDefault: makeDefault === true,
        loginSyncEnabled: loginSyncEnabled === true,
      }),
  );
  shell(
    "x-browser:profiles:sync-set",
    (_event, profileId: string, enabled: boolean) =>
      profileSync.setEnabled(String(profileId), enabled === true),
  );
  shell("x-browser:profiles:sync-now", (_event, profileId: string) =>
    profileSync.syncProfile(String(profileId), "manual"),
  );
  shell("x-browser:profiles:chrome-discover", () => chromeImport.discover());
  shell("x-browser:profiles:chrome-quit", () => chromeImport.quitChrome());
  shell(
    "x-browser:profiles:chrome-import",
    (
      event,
      profileDirName: string,
      makeDefault: boolean,
      allowPartial: boolean,
    ) => {
      const directory = String(profileDirName);
      if (!/^(Default|Profile [1-9][0-9]*)$/.test(directory)) {
        throw new Error("invalid Chrome profile directory");
      }
      return chromeImport.importProfile(
        directory,
        makeDefault === true,
        allowPartial === true,
        (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("x-browser:chrome-import-progress", progress);
          }
        },
      );
    },
  );
  shell("x-browser:overview:create", async (_event, name?: string, profileId?: string) => {
    const selectedProfileId = profileId ? String(profileId) : undefined;
    const space = await manager.createSpace(
      name || `Space ${manager.listSpaces().length + 1}`,
      "user",
      selectedProfileId,
    );
    await presentation.showSpace(space.id);
    if (!isTemporaryProfileId(space.profileId)) {
      profileSync.notifyProfileActive(space.profileId);
    }
    browserView.webContents.send("x-browser:browser-state", manager.navigationState(space.id));
    nativeChrome.update(manager.navigationState(space.id));
    return space;
  });
  shell("x-browser:overview:open", async (_event, spaceId: number, value?: unknown) => {
    const id = assertSpaceId(spaceId);
    const transition = (value ?? {}) as {
      token?: unknown;
      durationMs?: unknown;
    };
    const source = value
      ? clippedCaptureRect(value, overviewView.getBounds())
      : undefined;
    const token =
      typeof transition.token === "string" &&
      transition.token.length > 0 &&
      transition.token.length <= 128
        ? transition.token
        : undefined;
    const durationMs = Math.max(
      1,
      Math.min(2_000, Math.round(finiteNumber(transition.durationMs))),
    );
    const space = manager.getSpace(id);
    if (space && !isTemporaryProfileId(space.profileId)) {
      profileSync.notifyProfileActive(space.profileId);
    }
    browserView.webContents.send(
      "x-browser:browser-state",
      manager.navigationState(id),
    );
    nativeChrome.update(manager.navigationState(id));
    await presentation.showSpace(
      id,
      source ? { source, token, durationMs } : undefined,
    );
  });
  shell("x-browser:space-transition:finished", (_event, token: string) =>
    presentation.notifyTransitionFinished(String(token)),
  );
  shell("x-browser:overview:rename", (_event, spaceId: number, name: string) =>
    manager.renameSpace(assertSpaceId(spaceId), String(name)),
  );
  shell("x-browser:overview:close", async (_event, spaceId: number) => {
    const id = assertSpaceId(spaceId);
    const current = presentation.current();
    if (current.kind === "space" && current.spaceId === id) {
      await presentation.showOverview();
    }
    leases.release(id);
    await manager.closeSpace(id);
  });
  shell(
    "x-browser:overview:visible",
    (_event, cards: unknown, viewport: unknown) => {
      const safeViewport = previewRect(viewport);
      const safeCards = Array.isArray(cards)
        ? cards
            .slice(0, 64)
            .map((card) => {
              const value = card as { id?: unknown; rect?: unknown };
              return {
                id: Number(value?.id),
                rect: previewRect(value?.rect),
              };
            })
            .filter(
              (card) =>
                Number.isSafeInteger(card.id) &&
                card.id > 0 &&
                card.rect.width > 0 &&
                card.rect.height > 0,
            )
        : [];
      manager.setVisiblePreviewSpaces(
        visibleSpaceIds(safeCards, safeViewport, 8),
      );
      presentation.setOverviewTargets(safeCards);
    },
  );

  shell("x-browser:browser:state", () => currentBrowserState(context));
  shell("x-browser:browser:overview", () => presentation.showOverview());
  shell("x-browser:browser:create-tab", async (_event, url?: string) => {
    const spaceId = currentSpaceId(presentation);
    assertUserControl(manager, spaceId);
    const tab = await manager.createTab(spaceId, url);
    // Attaching the new page can make its WebContents the native first
    // responder. Return focus to persistent Browser Chrome so the renderer can
    // select the omnibox just like a normal browser new-tab action.
    const focusAddress = () => {
      if (browserView.webContents.isDestroyed()) return;
      browserView.webContents.focus();
      browserView.webContents.send(
        "x-browser:browser-focus-address",
        tab.targetId,
      );
    };
    focusAddress();
    setTimeout(focusAddress, 60);
    return manager.navigationState(spaceId);
  });
  shell("x-browser:browser:activate-tab", async (_event, targetId: string) => {
    const spaceId = currentSpaceId(presentation);
    assertUserControl(manager, spaceId);
    await manager.activateTab(spaceId, String(targetId));
  });
  shell(
    "x-browser:browser:reorder-tab",
    async (_event, targetId: string, beforeTargetId?: string | null) => {
      const spaceId = currentSpaceId(presentation);
      assertUserControl(manager, spaceId);
      await manager.reorderTab(
        spaceId,
        String(targetId),
        beforeTargetId == null ? null : String(beforeTargetId),
      );
      return manager.navigationState(spaceId);
    },
  );
  shell("x-browser:browser:close-tab", async (_event, targetId: string) => {
    const spaceId = currentSpaceId(presentation);
    assertUserControl(manager, spaceId);
    await manager.closeTab(spaceId, String(targetId));
  });
  shell("x-browser:browser:navigate", (_event, input: string) => {
    const spaceId = currentSpaceId(presentation);
    assertUserControl(manager, spaceId);
    return presentation.navigate(spaceId, String(input));
  });
  shell("x-browser:browser:back", () => {
    const spaceId = currentSpaceId(presentation);
    assertUserControl(manager, spaceId);
    return manager.goBack(spaceId);
  });
  shell("x-browser:browser:forward", () => {
    const spaceId = currentSpaceId(presentation);
    assertUserControl(manager, spaceId);
    return manager.goForward(spaceId);
  });
  shell("x-browser:browser:reload", () => {
    const spaceId = currentSpaceId(presentation);
    assertUserControl(manager, spaceId);
    return manager.reload(spaceId);
  });

  shell("x-browser:control:take-over", async (_event, spaceId: number) => {
    const id = assertSpaceId(spaceId);
    leases.release(id);
    await manager.setOwnership(id, "user", "active");
  });
  shell("x-browser:control:complete", async (_event, spaceId: number) => {
    const id = assertSpaceId(spaceId);
    leases.release(id);
    await manager.setLifecycle(id, "completed");
  });
  shell("x-browser:chat:send", (_event, text: string) => {
    const prompt = String(text).trim().slice(0, 2000);
    if (!prompt) throw new Error("message is empty");
    return context.claude.send(prompt);
  });
  shell("x-browser:chat:stop", () => context.claude.stop());

}

function currentBrowserState(context: IpcContext) {
  const presentation = context.presentation.current();
  if (presentation.kind !== "space") return null;
  return context.manager.navigationState(presentation.spaceId);
}

async function handleNativeBrowserChromeEvent(
  event: NativeBrowserChromeEvent,
  manager: TaskSpaceManager,
  presentation: PresentationCoordinator,
  nativeChrome: NativeBrowserChrome,
) {
  if (event.type === "show-overview") {
    await presentation.showOverview();
    return;
  }
  const spaceId = currentSpaceId(presentation);
  assertUserControl(manager, spaceId);
  switch (event.type) {
    case "new-tab":
      await manager.createTab(spaceId);
      setTimeout(() => nativeChrome.focusAddress(), 60);
      break;
    case "activate-tab":
      await manager.activateTab(spaceId, String(event.targetId));
      break;
    case "close-tab":
      await manager.closeTab(spaceId, String(event.targetId));
      break;
    case "navigate":
      await presentation.navigate(spaceId, String(event.value));
      break;
    case "back":
      await manager.goBack(spaceId);
      break;
    case "forward":
      await manager.goForward(spaceId);
      break;
    case "reload":
      await manager.reload(spaceId);
      break;
  }
  const current = presentation.current();
  if (current.kind === "space") {
    nativeChrome.update(manager.navigationState(current.spaceId));
  }
}

function currentSpaceId(presentation: PresentationCoordinator) {
  const current = presentation.current();
  if (current.kind !== "space") throw new Error("no visible space");
  return current.spaceId;
}

function assertUserControl(manager: TaskSpaceManager, spaceId: number) {
  const space = manager.getSpaceOrThrow(spaceId);
  if (space.ownership === "agent" && space.lifecycle === "active") {
    throw new Error("Agent controls this space");
  }
}

function assertSpaceId(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid space id");
  return value;
}

function overviewTraceOptions(value: unknown) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid trace options");
  }
  const input = value as Record<string, unknown>;
  return {
    after: Math.max(0, Math.floor(finiteNumber(input.after))),
    limit: Math.min(500, Math.max(1, Math.floor(finiteNumber(input.limit) || 120))),
  };
}

function previewRect(value: unknown): Rect {
  const rect = (value ?? {}) as Partial<Rect>;
  return {
    x: finiteNumber(rect.x),
    y: finiteNumber(rect.y),
    width: Math.max(0, finiteNumber(rect.width)),
    height: Math.max(0, finiteNumber(rect.height)),
  };
}

function clippedCaptureRect(value: unknown, bounds: Rect): Rect {
  const requested = previewRect(value);
  const x = Math.max(0, Math.min(Math.floor(requested.x), bounds.width - 1));
  const y = Math.max(0, Math.min(Math.floor(requested.y), bounds.height - 1));
  const width = Math.min(
    Math.max(1, Math.ceil(requested.width)),
    Math.max(1, bounds.width - x),
  );
  const height = Math.min(
    Math.max(1, Math.ceil(requested.height)),
    Math.max(1, bounds.height - y),
  );
  if (width < 32 || height < 32) {
    throw new Error("transition snapshot is too small");
  }
  return { x, y, width, height };
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolvePromise) => {
      timer = setTimeout(resolvePromise, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

async function captureWebContentsPng(view: WebContentsView) {
  const contents = view.webContents;
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  const result = (await contents.debugger.sendCommand("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  })) as { data: string };
  return Buffer.from(result.data, "base64");
}

async function runNativeBrowserInteractionAudit(context: {
  testRoot: string;
  window: BaseWindow;
  manager: TaskSpaceManager;
  presentation: PresentationCoordinator;
  browserView: WebContentsView;
  nativeChrome: NativeBrowserChrome;
}) {
  const { testRoot, window, manager, presentation, nativeChrome } = context;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitUntil = async (predicate: () => boolean, timeoutMs = 800) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) return false;
      await wait(5);
    }
    return true;
  };
  const pageUrl =
    "data:text/html,<title>Native%20Chrome%20Audit</title><main>Native%20Chrome%20Audit</main>";
  const space = await manager.createSpace("Native browser interaction audit", "user");
  let agentSpaceId: number | undefined;
  try {
    const page = await manager.createTab(space.id, pageUrl);
    await presentation.showSpace(space.id);
    nativeChrome.update(manager.navigationState(space.id));
    await wait(100);
    const pageView = manager.getView(page.targetId)!;
    await pageView.webContents.executeJavaScript(
      "globalThis.__ufoNativeChromeAudit = 'kept-context'",
      true,
    );
    const initial = nativeChrome.inspect();
    const initialSpaceCount = manager.listSpaces().length;
    const initialChromePng = nativeChrome.capturePng();
    if (initialChromePng) {
      await writeFile(
        join(testRoot, "browser-interaction-initial.png"),
        initialChromePng,
      );
    }
    const initialRootChildCount = window.contentView.children.length;

    const tabsBeforeNew = manager.getSpaceOrThrow(space.id).tabs.length;
    const newTabStartedAt = performance.now();
    const newTabOperation = handleNativeBrowserChromeEvent(
      { type: "new-tab" },
      manager,
      presentation,
      nativeChrome,
    );
    const newTabChromeCommitted = await waitUntil(
      () => nativeChrome.inspect()?.tabCount === tabsBeforeNew + 1,
    );
    const newTabChromeLatencyMs = performance.now() - newTabStartedAt;
    await newTabOperation;
    await wait(120);
    const afterNewSpace = manager.getSpaceOrThrow(space.id);
    const afterNewTabCount = afterNewSpace.tabs.length;
    const newTargetId = afterNewSpace.activeTabId;
    const afterNew = nativeChrome.inspect();

    const activateStartedAt = performance.now();
    const activateOperation = handleNativeBrowserChromeEvent(
      { type: "activate-tab", targetId: page.targetId },
      manager,
      presentation,
      nativeChrome,
    );
    const activateChromeCommitted = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).activeTabId === page.targetId,
    );
    const activateChromeLatencyMs = performance.now() - activateStartedAt;
    await activateOperation;
    await wait(80);
    const afterActivate = nativeChrome.inspect();
    const activatedTargetId = manager.getSpaceOrThrow(space.id).activeTabId;

    const closeStartedAt = performance.now();
    const closeOperation = handleNativeBrowserChromeEvent(
      { type: "close-tab", targetId: newTargetId },
      manager,
      presentation,
      nativeChrome,
    );
    const closeChromeCommitted = await waitUntil(
      () => nativeChrome.inspect()?.tabCount === tabsBeforeNew,
    );
    const closeChromeLatencyMs = performance.now() - closeStartedAt;
    await closeOperation;
    await wait(80);
    const afterClose = nativeChrome.inspect();
    const contextToken = await pageView.webContents.executeJavaScript(
      "globalThis.__ufoNativeChromeAudit",
      true,
    );
    const chromePng = nativeChrome.capturePng();
    if (chromePng) {
      await writeFile(join(testRoot, "browser-interaction-polish.png"), chromePng);
    }

    const delayedNavigationUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`
      <title>Native navigation handoff</title>
      <style>html { background: #173d2b; color: white; }</style>
      <main>New document is ready</main>
      <script type="module">
        await new Promise((resolve) => setTimeout(resolve, 480));
        document.documentElement.dataset.ready = "true";
      </script>
    `)}`;
    const navigationSubmitted =
      nativeChrome.submitAddressForTest(delayedNavigationUrl);
    const navigationHandoffShown = await waitUntil(
      () => presentation.navigationHandoffVisible(),
      600,
    );
    await wait(80);
    const navigationHandoffHeld = presentation.navigationHandoffVisible();
    const addressDuringNavigation = nativeChrome.inspect();
    const navigationSettled = await waitUntil(() => {
      const chrome = nativeChrome.inspect();
      return (
        chrome?.addressPending === false &&
        !presentation.navigationHandoffVisible()
      );
    }, 2_500);
    const navigationHandoffRemoved = !presentation.navigationHandoffVisible();
    const addressAfterNavigation = nativeChrome.inspect();

    const agentSpace = await manager.createSpace(
      "Native Agent titlebar drag audit",
      "agent",
    );
    agentSpaceId = agentSpace.id;
    await presentation.showSpace(agentSpace.id);
    nativeChrome.update(manager.navigationState(agentSpace.id));
    await wait(80);
    const agentControlled = nativeChrome.inspect();

    await handleNativeBrowserChromeEvent(
      { type: "show-overview" },
      manager,
      presentation,
      nativeChrome,
    );
    const overview = {
      presentation: presentation.current(),
      rootChildCount: window.contentView.children.length,
      chrome: nativeChrome.inspect(),
    };
    const ok =
      initial?.visible === true &&
      initial.titlebarDraggable === true &&
      initial.tabCount === tabsBeforeNew &&
      initial.spacesCount === String(initialSpaceCount) &&
      initial.addressFrame.height === 32 &&
      initial.addressFrame.width > 500 &&
      initial.titleHitClass === "UFOChromeHoverButton" &&
      initial.addressHitClass === "NSTextField" &&
      initialRootChildCount === 1 &&
      afterNewTabCount === tabsBeforeNew + 1 &&
      afterNew?.tabCount === tabsBeforeNew + 1 &&
      newTabChromeCommitted &&
      newTabChromeLatencyMs < 180 &&
      afterNew.addressFocused === true &&
      activatedTargetId === page.targetId &&
      activateChromeCommitted &&
      activateChromeLatencyMs < 180 &&
      afterActivate?.tabCount === tabsBeforeNew + 1 &&
      manager.getSpaceOrThrow(space.id).tabs.length === tabsBeforeNew &&
      closeChromeCommitted &&
      closeChromeLatencyMs < 180 &&
      afterClose?.tabCount === tabsBeforeNew &&
      contextToken === "kept-context" &&
      navigationSubmitted &&
      navigationHandoffShown &&
      navigationHandoffHeld &&
      addressDuringNavigation?.addressPending === true &&
      addressDuringNavigation.addressValue === delayedNavigationUrl &&
      navigationSettled &&
      navigationHandoffRemoved &&
      addressAfterNavigation?.addressPending === false &&
      Boolean(chromePng && chromePng.byteLength > 1_000) &&
      agentControlled?.controlled === true &&
      agentControlled.controlledTabDraggable === true &&
      overview.presentation.kind === "overview" &&
      overview.rootChildCount === 1 &&
      overview.chrome?.visible === false;
    await writeFile(
      join(testRoot, "interaction-audit.json"),
      `${JSON.stringify(
        {
          ok,
          mode: "native-appkit",
          initial,
          initialRootChildCount,
          afterNew,
          afterNewTabCount,
          newTabChromeCommitted,
          newTabChromeLatencyMs,
          afterActivate,
          activateChromeCommitted,
          activateChromeLatencyMs,
          afterClose,
          closeChromeCommitted,
          closeChromeLatencyMs,
          contextToken,
          navigationSubmitted,
          navigationHandoffShown,
          navigationHandoffHeld,
          addressDuringNavigation,
          navigationSettled,
          navigationHandoffRemoved,
          addressAfterNavigation,
          chromePngBytes: chromePng?.byteLength ?? 0,
          agentControlled,
          overview,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await presentation.showOverview().catch(() => undefined);
    if (agentSpaceId !== undefined) {
      await manager.closeSpace(agentSpaceId).catch(() => undefined);
    }
    await manager.closeSpace(space.id).catch(() => undefined);
  }
}

async function runBrowserInteractionAudit(context: {
  testRoot: string;
  window: BaseWindow;
  manager: TaskSpaceManager;
  presentation: PresentationCoordinator;
  browserView: WebContentsView;
  nativeChrome: NativeBrowserChrome;
}) {
  if (context.nativeChrome.isAvailable()) {
    await runNativeBrowserInteractionAudit(context);
    return;
  }
  const { testRoot, window, manager, presentation, browserView } = context;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitUntil = async (predicate: () => boolean, timeoutMs = 500) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) return false;
      await wait(5);
    }
    return true;
  };
  const pageAUrl =
    "data:text/html,<title>Interaction%20Audit%20A</title><main>Audit%20A</main>";
  const pageBUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <title>Interaction Audit B</title>
    <main>Audit B loading normally</main>
    <script type="module">
      await new Promise((resolve) => setTimeout(resolve, 900));
      document.body.dataset.loaded = "true";
    </script>
  `)}`;
  const space = await manager.createSpace("Browser interaction audit", "user");
  try {
    const pageA = await manager.createTab(space.id, pageAUrl);
    await presentation.showSpace(space.id);
    browserView.webContents.send(
      "x-browser:browser-state",
      manager.navigationState(space.id),
    );
    await wait(80);

    const pageAView = manager.getView(pageA.targetId)!;
    await pageAView.webContents.executeJavaScript(
      "globalThis.__xBrowserRoundTripToken = 'kept-context'",
      true,
    );
    await browserView.webContents.executeJavaScript(
      `(() => {
        const address = document.querySelector('#address');
        address.focus();
        address.value = 'editing must survive state updates';
        address.dispatchEvent(new Event('input', { bubbles: true }));
        globalThis.__xBrowserAuditTab = document.querySelector('.tab.active');
      })()`,
      true,
    );
    browserView.webContents.send(
      "x-browser:browser-state",
      manager.navigationState(space.id),
    );
    await wait(50);
    const editing = await browserView.webContents.executeJavaScript(
      `(() => ({
        value: document.querySelector('#address').value,
        focused: document.activeElement === document.querySelector('#address'),
        tabNodePreserved: globalThis.__xBrowserAuditTab === document.querySelector('.tab.active'),
      }))()`,
      true,
    );

    const coldTabStartedAt = Date.now();
    const pageB = await manager.createTab(space.id, pageBUrl);
    const createTabElapsedMs = Date.now() - coldTabStartedAt;
    const pageBView = manager.getView(pageB.targetId)!;
    const presentationSynced = await waitUntil(() =>
      window.contentView.children.includes(pageBView),
    );
    const presentationSyncElapsedMs = Date.now() - coldTabStartedAt;
    const coldLoadSamples: Array<{
      rootChildCount: number;
      browserAttached: boolean;
      pageAttached: boolean;
      pageVisible: boolean;
      pageWebContentsId: number;
      loading: boolean;
      backgroundSurface: boolean | null;
    }> = [];
    for (let sample = 0; sample < 5; sample++) {
      const diagnostics = manager.previewDiagnostics();
      const runtime = diagnostics.runtimes.find(
        (candidate) => candidate.targetId === pageB.targetId,
      );
      coldLoadSamples.push({
        rootChildCount: window.contentView.children.length,
        browserAttached: window.contentView.children.includes(browserView),
        pageAttached: window.contentView.children.includes(pageBView),
        pageVisible: pageBView.getVisible(),
        pageWebContentsId: pageBView.webContents.id,
        loading: pageBView.webContents.isLoading(),
        backgroundSurface: runtime?.backgroundSurface ?? null,
      });
      await wait(80);
    }
    const afterSecondTab = {
      rootChildCount: window.contentView.children.length,
      pageWebContentsId: manager.getView(pageB.targetId)?.webContents.id ?? 0,
      browserWebContentsId: browserView.webContents.id,
      createTabElapsedMs,
      presentationSynced,
      presentationSyncElapsedMs,
      coldLoadSamples,
    };

    await manager.activateTab(space.id, pageA.targetId);
    const activationPresentationSynced = await waitUntil(() =>
      window.contentView.children.includes(pageAView),
    );
    const afterSwitchBack = {
      rootChildCount: window.contentView.children.length,
      pageWebContentsId: manager.getView(pageA.targetId)?.webContents.id ?? 0,
      presentationSynced: activationPresentationSynced,
      contextToken: await pageAView.webContents.executeJavaScript(
        "globalThis.__xBrowserRoundTripToken",
        true,
      ),
    };

    await presentation.showOverview();
    const overviewRootChildCount = window.contentView.children.length;
    // Give Overview enough time to begin a bounded snapshot so returning to
    // the Space exercises the real capture-surface race, not only a quiet
    // detach/attach path.
    await wait(260);
    await presentation.showSpace(space.id);
    browserView.webContents.send(
      "x-browser:browser-state",
      manager.navigationState(space.id),
    );
    await wait(160);
    const surfaceDiagnostics = manager.previewDiagnostics();
    const pageSurface = surfaceDiagnostics.runtimes.find(
      (runtime) => runtime.targetId === pageA.targetId,
    );
    const afterRoundTrip = {
      rootChildCount: window.contentView.children.length,
      pageWebContentsId: manager.getView(pageA.targetId)?.webContents.id ?? 0,
      contextToken: await pageAView.webContents.executeJavaScript(
        "globalThis.__xBrowserRoundTripToken",
        true,
      ),
      reservedTargetId: surfaceDiagnostics.presentationReservedTargetId,
      presentedTargetId: surfaceDiagnostics.presentedTargetId,
      backgroundSurface: pageSurface?.backgroundSurface ?? null,
      primaryPreview: pageSurface?.primaryPreview ?? null,
      oneShotPreview: pageSurface?.oneShotPreview ?? null,
    };

    const tabsBeforeShortcutAudit = manager.getSpaceOrThrow(space.id).tabs.length;
    await browserView.webContents.executeJavaScript(
      "document.querySelector('#new-tab')?.click()",
      true,
    );
    const newTabCreated = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).tabs.length === tabsBeforeShortcutAudit + 1,
      900,
    );
    await wait(80);
    const afterNewTab = manager.getSpaceOrThrow(space.id);
    const firstTargetId = afterNewTab.tabs[0].targetId;
    const lastTargetId = afterNewTab.tabs[afterNewTab.tabs.length - 1].targetId;
    const newTabFocus = await browserView.webContents.executeJavaScript(
      `(() => ({
        focused: document.activeElement === document.querySelector('#address'),
        value: document.querySelector('#address')?.value || '',
        tabs: document.querySelectorAll('.tab').length,
      }))()`,
      true,
    );

    const dispatchChromeKey = (init: Record<string, unknown>) =>
      browserView.webContents.executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({
          bubbles: true,
          cancelable: true,
          ...init,
        })}))`,
        true,
      );
    await dispatchChromeKey({ key: "1", metaKey: true });
    const commandOneSelectedFirst = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).activeTabId === firstTargetId,
      900,
    );
    await dispatchChromeKey({ key: "9", metaKey: true });
    const commandNineSelectedLast = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).activeTabId === lastTargetId,
      900,
    );
    await dispatchChromeKey({ key: "Tab", ctrlKey: true, shiftKey: true });
    const controlShiftTabSelectedPrevious = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).activeTabId === pageB.targetId,
      900,
    );
    await dispatchChromeKey({ key: "Tab", ctrlKey: true });
    const controlTabSelectedNext = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).activeTabId === lastTargetId,
      900,
    );
    await dispatchChromeKey({ key: "[", metaKey: true, shiftKey: true });
    const commandShiftBracketSelectedPrevious = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).activeTabId === pageB.targetId,
      900,
    );
    await dispatchChromeKey({ key: "]", metaKey: true, shiftKey: true });
    const commandShiftBracketSelectedNext = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).activeTabId === lastTargetId,
      900,
    );
    const tabsBeforeIgnoredReopen = manager.getSpaceOrThrow(space.id).tabs.length;
    await dispatchChromeKey({ key: "T", metaKey: true, shiftKey: true });
    await wait(80);
    const shortcutAudit = {
      newTabCreated,
      newTabFocus,
      commandOneSelectedFirst,
      commandNineSelectedLast,
      controlShiftTabSelectedPrevious,
      controlTabSelectedNext,
      commandShiftBracketSelectedPrevious,
      commandShiftBracketSelectedNext,
      commandShiftTIgnored:
        manager.getSpaceOrThrow(space.id).tabs.length === tabsBeforeIgnoredReopen,
    };

    const activeViewIdBeforeReorder =
      manager.getView(lastTargetId)?.webContents.id ?? 0;
    const dragStarted = await browserView.webContents.executeJavaScript(
      `(() => {
        const buttons = [...document.querySelectorAll('.tab')];
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (!first || !last) return false;
        globalThis.__xBrowserDraggedTabButton = last;
        const transfer = { effectAllowed: 'none', dropEffect: 'none', setData() {} };
        const dragStart = new Event('dragstart', { bubbles: true, cancelable: true });
        Object.defineProperty(dragStart, 'dataTransfer', { value: transfer });
        last.dispatchEvent(dragStart);
        const rect = first.getBoundingClientRect();
        const dragOver = new Event('dragover', { bubbles: true, cancelable: true });
        Object.defineProperty(dragOver, 'clientX', { value: rect.left + 1 });
        Object.defineProperty(dragOver, 'dataTransfer', { value: transfer });
        first.dispatchEvent(dragOver);
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'clientX', { value: rect.left + 1 });
        Object.defineProperty(drop, 'dataTransfer', { value: transfer });
        first.dispatchEvent(drop);
        return true;
      })()`,
      true,
    );
    const dragReordered = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).tabs[0]?.targetId === lastTargetId,
      900,
    );
    await wait(80);
    const dragDom = await browserView.webContents.executeJavaScript(
      `(() => ({
        firstTargetId: document.querySelector('.tab')?.dataset.targetId || '',
        buttonPreserved:
          globalThis.__xBrowserDraggedTabButton === document.querySelector('.tab'),
        activeTargetId:
          document.querySelector('.tab.active')?.dataset.targetId || '',
      }))()`,
      true,
    );
    const reorderAudit = {
      dragStarted,
      dragReordered,
      dragDom,
      activeTargetStable:
        manager.getSpaceOrThrow(space.id).activeTabId === lastTargetId,
      webContentsStable:
        manager.getView(lastTargetId)?.webContents.id === activeViewIdBeforeReorder,
    };
    await browserView.webContents.executeJavaScript(
      `window.xBrowser.browser.reorderTab(${JSON.stringify(lastTargetId)}, null)`,
      true,
    );
    await waitUntil(
      () =>
        manager.getSpaceOrThrow(space.id).tabs.at(-1)?.targetId === lastTargetId,
      900,
    );

    await dispatchChromeKey({ key: "2", metaKey: true });
    const middleTargetActivated = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).activeTabId === pageA.targetId,
      900,
    );
    const rightNeighbourViewId =
      manager.getView(pageB.targetId)?.webContents.id ?? 0;
    const middleClickDispatched = await browserView.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector(
          '.tab[data-target-id="${pageA.targetId}"]',
        );
        if (!button) return false;
        button.dispatchEvent(new MouseEvent('auxclick', {
          bubbles: true,
          cancelable: true,
          button: 1,
        }));
        return true;
      })()`,
      true,
    );
    const middleClosed = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).tabs.length === tabsBeforeIgnoredReopen - 1,
      900,
    );
    const selectedRightNeighbour = await waitUntil(
      () => manager.getSpaceOrThrow(space.id).activeTabId === pageB.targetId,
      900,
    );
    await wait(80);
    const middleCloseAudit = {
      middleTargetActivated,
      middleClickDispatched,
      middleClosed,
      selectedRightNeighbour,
      closedRuntimeReleased: manager.getView(pageA.targetId) === undefined,
      rightNeighbourWebContentsStable:
        manager.getView(pageB.targetId)?.webContents.id === rightNeighbourViewId,
      domRemoved: await browserView.webContents.executeJavaScript(
        `!document.querySelector('.tab[data-target-id="${pageA.targetId}"]')`,
        true,
      ),
    };
    const spacesButtonVisual = await browserView.webContents.executeJavaScript(
      `(() => ({
        hasGridIcon: Boolean(document.querySelector('#spaces-button svg')),
        count: document.querySelector('#spaces-count')?.textContent || '',
      }))()`,
      true,
    );
    await writeFile(
      join(testRoot, "browser-interaction-polish.png"),
      await captureWebContentsPng(browserView),
    );

    const ok =
      editing.value === "editing must survive state updates" &&
      editing.focused === true &&
      editing.tabNodePreserved === true &&
      afterSecondTab.rootChildCount === 2 &&
      afterSecondTab.createTabElapsedMs < 500 &&
      afterSecondTab.presentationSynced === true &&
      afterSecondTab.presentationSyncElapsedMs < 500 &&
      afterSecondTab.coldLoadSamples.every(
        (sample) =>
          sample.rootChildCount === 2 &&
          sample.browserAttached &&
          sample.pageAttached &&
          sample.pageVisible &&
          sample.pageWebContentsId === afterSecondTab.pageWebContentsId &&
          sample.backgroundSurface === false,
      ) &&
      afterSwitchBack.rootChildCount === 2 &&
      afterSwitchBack.presentationSynced === true &&
      overviewRootChildCount === 1 &&
      afterRoundTrip.rootChildCount === 2 &&
      afterRoundTrip.reservedTargetId === pageA.targetId &&
      afterRoundTrip.presentedTargetId === pageA.targetId &&
      afterRoundTrip.backgroundSurface === false &&
      afterRoundTrip.primaryPreview === false &&
      afterRoundTrip.oneShotPreview === false &&
      afterSwitchBack.contextToken === "kept-context" &&
      afterRoundTrip.contextToken === "kept-context" &&
      afterSwitchBack.pageWebContentsId === afterRoundTrip.pageWebContentsId &&
      shortcutAudit.newTabCreated === true &&
      shortcutAudit.newTabFocus.focused === true &&
      shortcutAudit.newTabFocus.value === "" &&
      shortcutAudit.newTabFocus.tabs === tabsBeforeShortcutAudit + 1 &&
      shortcutAudit.commandOneSelectedFirst === true &&
      shortcutAudit.commandNineSelectedLast === true &&
      shortcutAudit.controlShiftTabSelectedPrevious === true &&
      shortcutAudit.controlTabSelectedNext === true &&
      shortcutAudit.commandShiftBracketSelectedPrevious === true &&
      shortcutAudit.commandShiftBracketSelectedNext === true &&
      shortcutAudit.commandShiftTIgnored === true &&
      reorderAudit.dragStarted === true &&
      reorderAudit.dragReordered === true &&
      reorderAudit.dragDom.firstTargetId === lastTargetId &&
      reorderAudit.dragDom.buttonPreserved === true &&
      reorderAudit.dragDom.activeTargetId === lastTargetId &&
      reorderAudit.activeTargetStable === true &&
      reorderAudit.webContentsStable === true &&
      middleCloseAudit.middleTargetActivated === true &&
      middleCloseAudit.middleClickDispatched === true &&
      middleCloseAudit.middleClosed === true &&
      middleCloseAudit.selectedRightNeighbour === true &&
      middleCloseAudit.closedRuntimeReleased === true &&
      middleCloseAudit.rightNeighbourWebContentsStable === true &&
      middleCloseAudit.domRemoved === true &&
      spacesButtonVisual.hasGridIcon === true &&
      spacesButtonVisual.count === String(manager.listSpaces().length);
    await writeFile(
      join(testRoot, "interaction-audit.json"),
      `${JSON.stringify(
        {
          ok,
          editing,
          afterSecondTab,
          afterSwitchBack,
          overviewRootChildCount,
          afterRoundTrip,
          shortcutAudit,
          reorderAudit,
          middleCloseAudit,
          spacesButtonVisual,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await presentation.showOverview().catch(() => undefined);
    await manager.closeSpace(space.id).catch(() => undefined);
  }
}

async function runControlUiAudit(context: {
  testRoot: string;
  window: BaseWindow;
  manager: TaskSpaceManager;
  presentation: PresentationCoordinator;
  browserView: WebContentsView;
  nativeChrome: NativeBrowserChrome;
  overviewView: WebContentsView;
  overlayView: WebContentsView;
}) {
  const {
    testRoot,
    window,
    manager,
    presentation,
    browserView,
    nativeChrome,
    overviewView,
    overlayView,
  } = context;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const space = await manager.createSpace("Agent control UI audit", "agent");
  const expectedSpaceCount = manager.listSpaces().length;
  try {
    await manager.setAgentTaskState(space.id, "正在检查页面状态");
    await manager.navigate(
      space.id,
      `data:text/html;charset=utf-8,${encodeURIComponent(`
        <!doctype html><meta charset="utf-8"><title>Agent UI Audit</title>
        <style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f4f5f3;color:#2d3532;font:16px -apple-system}.card{width:420px;padding:38px;border:1px solid #dce2df;border-radius:24px;background:#fff;box-shadow:0 24px 70px rgba(36,52,45,.1)}button{padding:12px 18px;border:0;border-radius:12px;background:#173d32;color:#fff}</style>
        <main class="card"><h1>Agent is browsing</h1><p>The page remains visible while UFO-Browser protects user input.</p><button onclick="window.clickCount=(window.clickCount||0)+1">Continue</button></main>
      `)}`,
    );
    const view = manager.getView(manager.getActiveTab(space.id).targetId)!;
    const backgroundBeforePresentation = {
      overlayAttached: window.contentView.children.includes(overlayView),
      pageOverlayPresent: await view.webContents.executeJavaScript(
        `Boolean(document.getElementById('__x_browser_agent_overlay'))`,
        true,
      ),
    };
    await presentation.showSpace(space.id);
    nativeChrome.update(manager.navigationState(space.id));
    browserView.webContents.send(
      "x-browser:browser-state",
      manager.navigationState(space.id),
    );
    await wait(420);
    const motionPreference = await overlayView.webContents.executeJavaScript(
      `({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches })`,
      true,
    );
    const motionFrameA = await captureWebContentsPng(overlayView);
    await wait(420);
    const motionFrameB = await captureWebContentsPng(overlayView);
    const animationAdvanced =
      motionPreference.reduced === true || !motionFrameA.equals(motionFrameB);
    await Promise.all([
      writeFile(join(testRoot, "control-ui-motion-a.png"), motionFrameA),
      writeFile(join(testRoot, "control-ui-motion-b.png"), motionFrameB),
    ]);
    manager.showAgentPointer(space.id, 720, 390);
    await wait(120);

    const nativeChromeInspection = nativeChrome.inspect();
    const chrome = nativeChromeInspection
      ? {
          controlled: nativeChromeInspection.controlled,
          lockVisible: nativeChromeInspection.controlled,
          spacesCount: nativeChromeInspection.spacesCount,
          spacesLabel: `共 ${nativeChromeInspection.spacesCount} 个空间`,
        }
      : await browserView.webContents.executeJavaScript(
          `(() => ({
            controlled: document.body.classList.contains('agent-controlled'),
            lockVisible: !document.querySelector('#chrome-lock')?.classList.contains('hidden'),
            spacesCount: document.querySelector('#spaces-count')?.textContent,
            spacesLabel: document.querySelector('#spaces-button')?.getAttribute('aria-label'),
          }))()`,
          true,
        );
    const overlay = await overlayView.webContents.executeJavaScript(
      `(() => ({
        design: document.body.dataset.overlayDesign,
        motion: document.body.dataset.overlayMotion,
        spaceId: document.body.dataset.spaceId,
        name: document.querySelector('#space-name')?.textContent,
        detail: document.querySelector('#task-detail')?.textContent,
        buttons: [...document.querySelectorAll('button')].map((button) => button.textContent?.trim()),
      }))()`,
      true,
    );
    const nativeOverlay = {
      attached: window.contentView.children.includes(overlayView),
      topmost: window.contentView.children.at(-1) === overlayView,
      bounds: overlayView.getBounds(),
      windowFocused: window.isFocused(),
      focused: overlayView.webContents.isFocused(),
    };
    view.webContents.setBackgroundThrottling(false);
    await wait(80);
    const pageButton = await view.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('main button');
        const rect = button?.getBoundingClientRect();
        return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
      })()`,
      true,
    );
    if (!pageButton) throw new Error("control audit button missing");
    const pageInputBefore = await view.webContents.executeJavaScript(
      `(() => {
        const point = ${JSON.stringify(pageButton)};
        const hit = document.elementFromPoint(point.x, point.y);
        return {
          innerWidth,
          innerHeight,
          focused: document.hasFocus(),
          visibility: document.visibilityState,
          hit: hit?.tagName || null,
          hitText: hit?.textContent?.trim() || null,
        };
      })()`,
      true,
    );
    if (!view.webContents.debugger.isAttached()) view.webContents.debugger.attach("1.3");
    // Match the real CdpBroker input path. A background test window must not
    // steal macOS focus, but Chromium still needs focus emulation around its
    // trusted page input for the click to land.
    await view.webContents.debugger.sendCommand(
      "Emulation.setFocusEmulationEnabled",
      { enabled: true },
    );
    try {
      await view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: pageButton.x,
        y: pageButton.y,
        button: "left",
        clickCount: 1,
      });
      await view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: pageButton.x,
        y: pageButton.y,
        button: "left",
        clickCount: 1,
      });
    } finally {
      await view.webContents.debugger.sendCommand(
        "Emulation.setFocusEmulationEnabled",
        { enabled: false },
      );
    }
    await wait(80);
    const agentClickCount = await view.webContents.executeJavaScript(
      `Number(window.clickCount || 0)`,
      true,
    );
    const pageInputAfter = await view.webContents.executeJavaScript(
      `({ focused: document.hasFocus(), visibility: document.visibilityState })`,
      true,
    );
    overlayView.webContents.sendInputEvent({
      type: "mouseDown",
      x: Math.round(pageButton.x),
      y: Math.round(pageButton.y),
      button: "left",
      clickCount: 1,
    });
    overlayView.webContents.sendInputEvent({
      type: "mouseUp",
      x: Math.round(pageButton.x),
      y: Math.round(pageButton.y),
      button: "left",
      clickCount: 1,
    });
    await wait(80);
    const humanAttemptClickCount = await view.webContents.executeJavaScript(
      `Number(window.clickCount || 0)`,
      true,
    );
    view.webContents.setBackgroundThrottling(true);
    const pageIsolation = await view.webContents.executeJavaScript(
      `({ overlayNode: Boolean(document.getElementById('__x_browser_agent_overlay')) })`,
      true,
    );
    const chromePng = nativeChrome.capturePng();
    if (chromePng) {
      await writeFile(join(testRoot, "control-ui-chrome.png"), chromePng);
    } else {
      await writeFile(
        join(testRoot, "control-ui-chrome.png"),
        await captureWebContentsPng(browserView),
      );
    }
    await writeFile(join(testRoot, "control-ui-page.png"), await captureWebContentsPng(view));
    await writeFile(join(testRoot, "control-ui-overlay.png"), await captureWebContentsPng(overlayView));

    if (nativeChromeInspection) {
      await presentation.showOverview();
    } else {
      await browserView.webContents.executeJavaScript(
        "document.querySelector('#spaces-button')?.click()",
        true,
      );
    }
    await wait(220);
    const backgroundAfterReturn = {
      overlayAttached: window.contentView.children.includes(overlayView),
      pageOverlayPresent: await view.webContents.executeJavaScript(
        `Boolean(document.getElementById('__x_browser_agent_overlay'))`,
        true,
      ),
    };
    const returned = {
      overview: presentation.current().kind === "overview",
      rootChildCount: window.contentView.children.length,
      runtimePreserved: Boolean(manager.getView(space.activeTabId)),
    };
    await writeFile(
      join(testRoot, "control-ui-overview.png"),
      await captureWebContentsPng(overviewView),
    );

    const closingPageContents = view.webContents;
    await presentation.showSpace(space.id);
    await wait(120);
    await manager.closeSpace(space.id);
    await wait(120);
    const closeWhilePresented = {
      overview: presentation.current().kind === "overview",
      rootChildCount: window.contentView.children.length,
      overviewAttached: window.contentView.children.includes(overviewView),
      browserAttached: window.contentView.children.includes(browserView),
      pageAttached: window.contentView.children.includes(view),
      overlayAttached: window.contentView.children.includes(overlayView),
      spacePresent: Boolean(manager.getSpace(space.id)),
      pageDestroyed: closingPageContents.isDestroyed(),
    };

    const ok =
      chrome.controlled === true &&
      chrome.lockVisible === true &&
      chrome.spacesCount === String(expectedSpaceCount) &&
      new RegExp(`共 ${expectedSpaceCount} 个`).test(chrome.spacesLabel || "") &&
      backgroundBeforePresentation.overlayAttached === false &&
      backgroundBeforePresentation.pageOverlayPresent === false &&
      nativeOverlay.attached === true &&
      nativeOverlay.topmost === true &&
      nativeOverlay.bounds.y === BROWSER_CHROME_HEIGHT &&
      nativeOverlay.bounds.width > 0 &&
      nativeOverlay.bounds.height > 0 &&
      nativeOverlay.focused === nativeOverlay.windowFocused &&
      overlay.design === "agent-dot-matrix-v3" &&
      overlay.motion === "ambient-sweep-v2" &&
      overlay.spaceId === String(space.id) &&
      overlay.name === space.name &&
      overlay.detail === "正在检查页面状态" &&
      overlay.buttons?.join(",") === "接管,终止任务" &&
      pageIsolation.overlayNode === false &&
      agentClickCount === 1 &&
      humanAttemptClickCount === 1 &&
      animationAdvanced === true &&
      returned.overview === true &&
      backgroundAfterReturn.overlayAttached === false &&
      backgroundAfterReturn.pageOverlayPresent === false &&
      returned.rootChildCount === 1 &&
      returned.runtimePreserved === true &&
      closeWhilePresented.overview === true &&
      closeWhilePresented.rootChildCount === 1 &&
      closeWhilePresented.overviewAttached === true &&
      closeWhilePresented.browserAttached === false &&
      closeWhilePresented.pageAttached === false &&
      closeWhilePresented.overlayAttached === false &&
      closeWhilePresented.spacePresent === false &&
      closeWhilePresented.pageDestroyed === true;
    await writeFile(
      join(testRoot, "control-ui-audit.json"),
      `${JSON.stringify({ ok, chrome, backgroundBeforePresentation, nativeOverlay, overlay, pageIsolation, pageButton, pageInputBefore, pageInputAfter, agentClickCount, humanAttemptClickCount, motionPreference, animationAdvanced, backgroundAfterReturn, returned, closeWhilePresented }, null, 2)}\n`,
    );
  } finally {
    await presentation.showOverview().catch(() => undefined);
    await manager.closeSpace(space.id).catch(() => undefined);
  }
}

async function runSpaceUiAudit(context: {
  testRoot: string;
  manager: TaskSpaceManager;
  profiles: BrowserProfileRegistry;
  presentation: PresentationCoordinator;
  overviewView: WebContentsView;
  eventJournal: SpaceEventJournal;
}) {
  const {
    testRoot,
    manager,
    profiles,
    presentation,
    overviewView,
    eventJournal,
  } = context;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const initial = manager.listSpaces()[0];
  if (!initial) throw new Error("space UI audit requires one Space");
  const alternateProfileId = "space-ui-alternate";
  if (!profiles.list().some((profile) => profile.id === alternateProfileId)) {
    const now = Date.now();
    await profiles.add({
      id: alternateProfileId,
      partitionId: "x-browser-profile-space-ui-alternate",
      name: "工作 Profile",
      kind: "local",
      createdAt: now,
      updatedAt: now,
    });
  }
  const defaultProfileId = profiles.getDefault().id;
  await wait(220);

  const menu = await overviewView.webContents.executeJavaScript(
    `(() => {
      const card = document.querySelector('[data-space-id="${initial.id}"]');
      const trigger = card?.querySelector('.card-menu-trigger');
      trigger?.click();
      const popover = card?.querySelector('.card-menu-popover');
      return {
        card: Boolean(card),
        expanded: trigger?.getAttribute('aria-expanded'),
        hidden: popover?.hidden,
        items: popover?.querySelectorAll('.card-menu-item').length || 0,
      };
    })()`,
    true,
  );
  await wait(80);
  const traceScreenshotPath = join(testRoot, "space-trace-failure.png");
  const menuPng = await captureWebContentsPng(overviewView);
  await writeFile(join(testRoot, "space-menu.png"), menuPng);
  await writeFile(traceScreenshotPath, menuPng);
  const traceFixture = eventJournal.append({
    spaceId: initial.id,
    tabId: initial.activeTabId,
    category: "action",
    type: "action.finished",
    data: {
      action: "click",
      target: { role: "button", name: "提交" },
      status: "failed",
      durationMs: 420,
      error: {
        name: "TimeoutError",
        code: "EGO_ACTIONABILITY_FAILED",
        message: "按钮被遮挡",
      },
      screenshot: traceScreenshotPath,
    },
  });

  await overviewView.webContents.executeJavaScript(
    `document.querySelector('[data-space-id="${initial.id}"] .card-menu-item:nth-child(2)')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `!document.querySelector('#trace-dialog-backdrop')?.hidden && !document.querySelector('#trace-dialog-content .dialog-loading')`,
  );
  const traceDialog = await overviewView.webContents.executeJavaScript(
    `(() => ({
      visible: !document.querySelector('#trace-dialog-backdrop')?.hidden,
      title: document.querySelector('#trace-dialog-title')?.textContent || '',
      empty: document.querySelector('#trace-dialog-content .trace-empty strong')?.textContent || '',
      rows: document.querySelectorAll('.trace-event-row').length,
      detail: document.querySelector('.trace-event-row small')?.textContent || '',
      screenshotButton: document.querySelector('.trace-screenshot-button')?.textContent || '',
    }))()`,
    true,
  );
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.trace-screenshot-button')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `!document.querySelector('#trace-screenshot-viewer')?.hidden && document.querySelector('#trace-screenshot-image')?.getAttribute('src')?.startsWith('data:image/png;base64,')`,
  );
  const traceScreenshot = await overviewView.webContents.executeJavaScript(
    `(() => ({
      visible: !document.querySelector('#trace-screenshot-viewer')?.hidden,
      title: document.querySelector('#trace-screenshot-title')?.textContent || '',
      imageReady: Boolean(document.querySelector('#trace-screenshot-image')?.getAttribute('src')?.startsWith('data:image/png;base64,')),
    }))()`,
    true,
  );
  await writeFile(
    join(testRoot, "space-trace.png"),
    await captureWebContentsPng(overviewView),
  );
  await overviewView.webContents.executeJavaScript(
    `(() => {
      document.querySelector('#trace-screenshot-close')?.click();
      document.querySelector('#trace-dialog-close')?.click();
      document.querySelector('[data-space-id="${initial.id}"] .card-menu-trigger')?.click();
    })()`,
    true,
  );

  const renameStarted = await overviewView.webContents.executeJavaScript(
    `(() => {
      const card = document.querySelector('[data-space-id="${initial.id}"]');
      card?.querySelector('.card-menu-item:not(.danger)')?.click();
      const editor = card?.querySelector('.space-title-editor');
      return {
        renaming: card?.classList.contains('renaming'),
        focused: document.activeElement === editor,
        value: editor?.value || '',
      };
    })()`,
    true,
  );
  await writeFile(
    join(testRoot, "space-rename.png"),
    await captureWebContentsPng(overviewView),
  );

  const renamedValue = `${initial.name} · UI Audit`;
  await overviewView.webContents.executeJavaScript(
    `(() => {
      const card = document.querySelector('[data-space-id="${initial.id}"]');
      const editor = card?.querySelector('.space-title-editor');
      if (!editor) return false;
      editor.value = ${JSON.stringify(renamedValue)};
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      }));
      return true;
    })()`,
    true,
  );
  await wait(220);
  const finalDom = await overviewView.webContents.executeJavaScript(
    `(() => {
      const card = document.querySelector('[data-space-id="${initial.id}"]');
      return {
        renaming: card?.classList.contains('renaming'),
        title: card?.querySelector('.space-title-line strong')?.textContent || '',
        menuHidden: card?.querySelector('.card-menu-popover')?.hidden,
      };
    })()`,
    true,
  );
  const storedName = manager.getSpaceOrThrow(initial.id).name;
  const originalState = manager.getSpaceOrThrow(initial.id);
  const originalOwnership = originalState.ownership;
  const originalLifecycle = originalState.lifecycle;
  await manager.setOwnership(initial.id, "user", "active");
  await wait(120);
  const visualBefore = await overviewView.webContents.executeJavaScript(
    `(() => {
      const card = document.querySelector('[data-space-id="${initial.id}"]');
      const preview = card?.querySelector('.space-preview');
      const title = card?.querySelector('.space-title-line strong');
      const create = document.querySelector('.create-space-card');
      const plus = create?.querySelector('.create-space-plus');
      const profileTrigger = create?.querySelector('.create-space-profile-trigger');
      const brandIcon = document.querySelector('.overview-brand > img');
      return {
        brandName: document.querySelector('.overview-brand strong')?.textContent || '',
        brandVersion: document.querySelector('#app-version')?.textContent || '',
        brandIconReady: Boolean(brandIcon?.complete && brandIcon?.naturalWidth),
        brandIconSource: brandIcon?.getAttribute('src') || '',
        spaceId: card?.querySelector('.space-id-badge')?.textContent || '',
        titleX: title?.getBoundingClientRect().x || 0,
        previewRadius: preview ? getComputedStyle(preview).borderRadius : '',
        previewShadow: preview ? getComputedStyle(preview).boxShadow : '',
        createRadius: create ? getComputedStyle(create).borderRadius : '',
        plusBorder: plus ? getComputedStyle(plus).borderStyle : '',
        profileTriggerRadius: profileTrigger ? getComputedStyle(profileTrigger).borderRadius : '',
        profileTriggerHeight: profileTrigger ? getComputedStyle(profileTrigger).height : '',
      };
    })()`,
    true,
  );
  await manager.setOwnership(initial.id, "agent", "active");
  await wait(120);
  const controlledVisual = await overviewView.webContents.executeJavaScript(
    `(() => {
      const card = document.querySelector('[data-space-id="${initial.id}"]');
      const preview = card?.querySelector('.space-preview');
      const title = card?.querySelector('.space-title-line strong');
      const detail = card?.querySelector('.space-meta span:first-child');
      const dot = detail ? getComputedStyle(detail, '::before') : null;
      const frame = preview ? getComputedStyle(preview, '::before') : null;
      return {
        controlled: card?.getAttribute('data-controlled'),
        titleX: title?.getBoundingClientRect().x || 0,
        previewBorderColor: preview ? getComputedStyle(preview).borderColor : '',
        previewShadow: preview ? getComputedStyle(preview).boxShadow : '',
        runningChipPresent: Boolean(card?.querySelector('.running-chip')),
        dotWidth: dot?.width || '',
        dotDisplay: dot?.display || '',
        frameDisplay: frame?.display || '',
        frameBorderWidth: frame?.borderTopWidth || '',
        frameAnimation: frame?.animationName || '',
      };
    })()`,
    true,
  );
  await writeFile(
    join(testRoot, "space-controlled.png"),
    await captureWebContentsPng(overviewView),
  );
  await manager.setOwnership(
    initial.id,
    originalOwnership,
    originalLifecycle,
  );
  const transitionStartedAt = performance.now();
  const rendererTransitionBefore = await overviewView.webContents.executeJavaScript(
    `(() => ({
      stagePresent: Boolean(document.querySelector('.space-enter-transition')),
      bodyLocked: document.body.classList.contains('space-entering'),
    }))()`,
    true,
  );
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('[data-space-id="${initial.id}"]')?.click()`,
    true,
  );
  await waitUntil(
    () => {
      const current = presentation.current();
      return current.kind === "space" && current.spaceId === initial.id;
    },
    3_000,
  );
  const transitionElapsedMs = Number(
    (performance.now() - transitionStartedAt).toFixed(1),
  );
  const rendererTransitionAfter = await overviewView.webContents.executeJavaScript(
    `(() => ({
      stagePresent: Boolean(document.querySelector('.space-enter-transition')),
      bodyLocked: document.body.classList.contains('space-entering'),
    }))()`,
    true,
  );
  await presentation.showOverview();
  await wait(140);
  const initialSpaceCount = manager.listSpaces().length;
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.create-space-profile-trigger')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `!document.querySelector('.create-profile-popover')?.hidden && document.querySelectorAll('.create-profile-option').length >= 2`,
  );
  const createMenu = await overviewView.webContents.executeJavaScript(
    `(() => {
      const trigger = document.querySelector('.create-space-profile-trigger');
      const popover = document.querySelector('.create-profile-popover');
      return {
        expanded: trigger?.getAttribute('aria-expanded') || '',
        label: document.querySelector('.create-space-profile-label')?.textContent || '',
        heading: popover?.querySelector('.create-profile-heading')?.textContent || '',
        profileIds: [...document.querySelectorAll('.create-profile-option')].map((option) => option.getAttribute('data-profile-id')),
        names: [...document.querySelectorAll('.create-profile-option-name')].map((name) => name.textContent || ''),
        modalPresent: Boolean(document.querySelector('.create-space-form:not(.profile-clone-form)')),
      };
    })()`,
    true,
  );
  await writeFile(
    join(testRoot, "space-create-profile-menu.png"),
    await captureWebContentsPng(overviewView),
  );
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.create-space-main')?.click()`,
    true,
  );
  await waitUntil(
    () => manager.listSpaces().length === initialSpaceCount + 1,
    3_000,
  );
  await waitForRenderer(
    overviewView,
    `document.querySelector('.create-space-card')?.getAttribute('data-busy') === '0'`,
    5_000,
  );
  const defaultCreated = manager.listSpaces().at(-1)!;
  const defaultCreationDom = await overviewView.webContents.executeJavaScript(
    `(() => ({
      menuHidden: document.querySelector('.create-profile-popover')?.hidden,
      modalPresent: Boolean(document.querySelector('.create-space-form:not(.profile-clone-form)')),
    }))()`,
    true,
  );
  await presentation.showOverview();
  await wait(140);
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.create-space-profile-trigger')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `!document.querySelector('.create-profile-popover')?.hidden`,
  );
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.create-profile-option[data-profile-id="${alternateProfileId}"]')?.click()`,
    true,
  );
  await waitUntil(
    () => manager.listSpaces().length === initialSpaceCount + 2,
    3_000,
  );
  await waitForRenderer(
    overviewView,
    `document.querySelector('.create-space-card')?.getAttribute('data-busy') === '0'`,
    5_000,
  );
  const alternateCreated = manager.listSpaces().at(-1)!;
  await presentation.showOverview();
  await wait(140);
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.create-space-profile-trigger')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `!document.querySelector('.create-profile-popover')?.hidden`,
  );
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.create-profile-option[data-profile-id="${TEMPORARY_PROFILE_ID}"]')?.click()`,
    true,
  );
  await waitUntil(
    () => manager.listSpaces().length === initialSpaceCount + 3,
    3_000,
  );
  await waitForRenderer(
    overviewView,
    `document.querySelector('.create-space-card')?.getAttribute('data-busy') === '0'`,
    5_000,
  );
  const temporaryCreated = manager.listSpaces().at(-1)!;
  await presentation.showOverview();
  await wait(180);
  const temporaryCard = await overviewView.webContents.executeJavaScript(
    `(() => {
      const card = document.querySelector('[data-space-id="${temporaryCreated.id}"]');
      return {
        present: Boolean(card),
        temporary: card?.getAttribute('data-temporary') || '',
        profile: card?.querySelector('.space-profile')?.textContent || '',
        profileTitle: card?.querySelector('.space-profile')?.getAttribute('title') || '',
      };
    })()`,
    true,
  );
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('#profile-button')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `Boolean(document.querySelector('.profile-row[data-profile-id="${TEMPORARY_PROFILE_ID}"]'))`,
  );
  const temporaryProfileUi = await overviewView.webContents.executeJavaScript(
    `(() => {
      const row = document.querySelector('.profile-row[data-profile-id="${TEMPORARY_PROFILE_ID}"]');
      return {
        present: Boolean(row),
        temporaryClass: row?.classList.contains('temporary') || false,
        name: row?.querySelector('.profile-row-copy strong')?.textContent || '',
        detail: row?.querySelector('.profile-row-copy small')?.textContent || '',
        badge: row?.querySelector('.profile-row-temporary-badge')?.textContent || '',
        selectDisabled: row?.querySelector('.profile-row-select')?.disabled || false,
        clonePresent: Boolean(row?.querySelector('.profile-row-clone')),
      };
    })()`,
    true,
  );
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('#profile-dialog-close')?.click()`,
    true,
  );
  const ok =
    menu.card === true &&
    menu.expanded === "true" &&
    menu.hidden === false &&
    menu.items === 3 &&
    traceDialog.visible === true &&
    /Agent 执行记录/.test(traceDialog.title) &&
    traceDialog.empty === "" &&
    traceDialog.rows === 1 &&
    traceDialog.detail.includes("EGO_ACTIONABILITY_FAILED: 按钮被遮挡") &&
    traceDialog.screenshotButton === "截图" &&
    traceScreenshot.visible === true &&
    traceScreenshot.imageReady === true &&
    traceScreenshot.title.includes("失败 click") &&
    traceFixture.sequence > 0 &&
    renameStarted.renaming === true &&
    renameStarted.focused === true &&
    renameStarted.value === initial.name &&
    storedName === renamedValue &&
    finalDom.renaming === false &&
    finalDom.title === renamedValue &&
    finalDom.menuHidden === true &&
    visualBefore.brandName === "UFO-Browser" &&
    visualBefore.brandVersion === `v${app.getVersion()}` &&
    visualBefore.brandIconReady === true &&
    visualBefore.brandIconSource === "./app-icon.png" &&
    visualBefore.spaceId === `ID ${initial.id}` &&
    visualBefore.previewRadius === "18px" &&
    visualBefore.createRadius === "18px" &&
    visualBefore.plusBorder === "none" &&
    visualBefore.profileTriggerRadius === "999px" &&
    visualBefore.profileTriggerHeight === "40px" &&
    controlledVisual.controlled === "1" &&
    controlledVisual.runningChipPresent === false &&
    controlledVisual.dotWidth === "5px" &&
    controlledVisual.dotDisplay === "inline-block" &&
    controlledVisual.frameDisplay === "block" &&
    controlledVisual.frameBorderWidth === "2px" &&
    controlledVisual.frameAnimation === "agent-card-frame-breathe" &&
    Math.abs(controlledVisual.titleX - visualBefore.titleX) < 0.5 &&
    controlledVisual.previewShadow !== visualBefore.previewShadow &&
    rendererTransitionBefore.stagePresent === false &&
    rendererTransitionBefore.bodyLocked === false &&
    rendererTransitionAfter.stagePresent === false &&
    rendererTransitionAfter.bodyLocked === false &&
    transitionElapsedMs < 900 &&
    createMenu.expanded === "true" &&
    createMenu.heading === "使用其他个人资料创建 Space" &&
    createMenu.profileIds.includes(defaultProfileId) &&
    createMenu.profileIds.includes(alternateProfileId) &&
    createMenu.profileIds.includes(TEMPORARY_PROFILE_ID) &&
    createMenu.names.includes("临时 Profile") &&
    createMenu.names.includes("工作 Profile") &&
    createMenu.modalPresent === false &&
    defaultCreated.profileId === defaultProfileId &&
    defaultCreated.tabs[0]?.url === "https://www.google.com/" &&
    defaultCreationDom.menuHidden === true &&
    defaultCreationDom.modalPresent === false &&
    alternateCreated.profileId === alternateProfileId &&
    alternateCreated.tabs[0]?.url === "https://www.google.com/" &&
    temporaryCreated.profileId === TEMPORARY_PROFILE_ID &&
    temporaryCreated.profileMode === "temporary" &&
    Boolean(temporaryCreated.sessionScopeId) &&
    temporaryCreated.tabs[0]?.url === "https://www.google.com/" &&
    temporaryCard.present === true &&
    temporaryCard.temporary === "1" &&
    temporaryCard.profile === "一次性 Space" &&
    temporaryProfileUi.present === true &&
    temporaryProfileUi.temporaryClass === true &&
    temporaryProfileUi.name === "临时 Profile" &&
    temporaryProfileUi.detail.includes("登录状态完全独立") &&
    temporaryProfileUi.badge === "一次性" &&
    temporaryProfileUi.selectDisabled === true &&
    temporaryProfileUi.clonePresent === false;
  await manager.renameSpace(initial.id, initial.name);
  await presentation.showOverview();
  await manager.closeSpace(defaultCreated.id);
  await manager.closeSpace(alternateCreated.id);
  await manager.closeSpace(temporaryCreated.id);
  await writeFile(
    join(testRoot, "space-ui-audit.json"),
    `${JSON.stringify(
      {
        ok,
        menu,
        traceDialog,
        traceScreenshot,
        renameStarted,
        storedName,
        finalDom,
        visualBefore,
        controlledVisual,
        openingTransition: {
          rendererBefore: rendererTransitionBefore,
          rendererAfter: rendererTransitionAfter,
          elapsedMs: transitionElapsedMs,
        },
        createMenu,
        defaultCreation: {
          profileId: defaultCreated.profileId,
          url: defaultCreated.tabs[0]?.url,
          dom: defaultCreationDom,
        },
        alternateCreation: {
          profileId: alternateCreated.profileId,
          url: alternateCreated.tabs[0]?.url,
        },
        temporaryCreation: {
          profileId: temporaryCreated.profileId,
          profileMode: temporaryCreated.profileMode,
          sessionScopePresent: Boolean(temporaryCreated.sessionScopeId),
          url: temporaryCreated.tabs[0]?.url,
          card: temporaryCard,
          profileUi: temporaryProfileUi,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function runChromeImportUiAudit(context: {
  testRoot: string;
  userDataPath: string;
  manager: TaskSpaceManager;
  profiles: BrowserProfileRegistry;
  overviewView: WebContentsView;
}) {
  const { testRoot, userDataPath, manager, profiles, overviewView } = context;
  await seedChromeFixtureOriginStorage();
  const initialSpaceCount = manager.listSpaces().length;
  await overviewView.webContents.executeJavaScript(
    `(() => {
      globalThis.__chromeImportProgress = [];
      window.xBrowser.profiles.onImportProgress((progress) => {
        globalThis.__chromeImportProgress.push({
          phase: String(progress?.phase || ''),
          completed: Number(progress?.completed || 0),
          total: Number(progress?.total || 0),
          detailCode: String(progress?.detailCode || ''),
        });
      });
      document.querySelector('#profile-button')?.click();
    })()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `Boolean(document.querySelector('.import-command'))`,
  );
  const profileHome = await overviewView.webContents.executeJavaScript(
    `(() => ({
      dialogVisible: !document.querySelector('#profile-dialog-backdrop')?.hidden,
      profileRows: document.querySelectorAll('.profile-row').length,
      importLabel: document.querySelector('.import-command strong')?.textContent || '',
      syncNote: document.querySelector('.profile-sync-note')?.textContent || '',
    }))()`,
    true,
  );
  const discoveryStartedAt = performance.now();
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.import-command')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `Boolean(document.querySelector('.chrome-profile-row'))`,
  );
  const discoveryElapsedMs = Number(
    (performance.now() - discoveryStartedAt).toFixed(1),
  );
  const runningSource = await overviewView.webContents.executeJavaScript(
    `(() => ({
      warning: document.querySelector('.source-status')?.classList.contains('warning') === true,
      title: document.querySelector('.source-status strong')?.textContent || '',
      action: document.querySelector('.source-status button')?.textContent || '',
      submitDisabled: Boolean(document.querySelector('.chrome-import-form button[type="submit"]')?.disabled),
    }))()`,
    true,
  );
  await writeFile(
    join(testRoot, "chrome-import-running-source.png"),
    await captureWebContentsPng(overviewView),
  );
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.source-status.warning button')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `document.querySelector('.source-status')?.classList.contains('ready') === true && !document.querySelector('.chrome-import-form button[type="submit"]')?.disabled`,
  );
  const sourceReady = await overviewView.webContents.executeJavaScript(
    `(() => ({
      ready: document.querySelector('.source-status')?.classList.contains('ready') === true,
      title: document.querySelector('.source-status strong')?.textContent || '',
      submitDisabled: Boolean(document.querySelector('.chrome-import-form button[type="submit"]')?.disabled),
    }))()`,
    true,
  );
  const discovery = await overviewView.webContents.executeJavaScript(
    `(() => ({
      title: document.querySelector('#profile-dialog-title')?.textContent || '',
      profiles: [...document.querySelectorAll('.chrome-profile-row')].map((row) => ({
        name: row.querySelector('strong')?.textContent || '',
        detail: row.querySelector('small')?.textContent || '',
        selected: Boolean(row.querySelector('input')?.checked),
      })),
      scope: document.querySelector('.import-scope-note')?.textContent || '',
      partialAllowed: Boolean(document.querySelector('.partial-import-choice input')?.checked),
      submitEnabled: !document.querySelector('.chrome-import-form button[type="submit"]')?.disabled,
    }))()`,
    true,
  );
  const heartbeatIntervalMs = 5;
  let heartbeatTicks = 0;
  let maxHeartbeatGapMs = 0;
  let previousHeartbeatAt = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - previousHeartbeatAt);
    previousHeartbeatAt = now;
    heartbeatTicks += 1;
  }, heartbeatIntervalMs);
  try {
    await overviewView.webContents.executeJavaScript(
      `document.querySelector('.chrome-import-form')?.requestSubmit()`,
      true,
    );
    await waitForRenderer(
      overviewView,
      `Boolean(document.querySelector('.import-result-view, .dialog-error-view'))`,
      12_000,
    );
  } finally {
    clearInterval(heartbeat);
  }
  const mainThreadResponsiveness = {
    heartbeatTicks,
    maxGapMs: Number(maxHeartbeatGapMs.toFixed(1)),
    maxStallMs: Number(
      Math.max(0, maxHeartbeatGapMs - heartbeatIntervalMs).toFixed(1),
    ),
  };
  const importFailed = await overviewView.webContents.executeJavaScript(
    `Boolean(document.querySelector('.dialog-error-view'))`,
    true,
  );
  if (importFailed) {
    throw new Error(
      `Chrome import verification diagnostic: ${JSON.stringify(
        await diagnoseChromeImportFailure(userDataPath),
      )}`,
    );
  }
  const result = await overviewView.webContents.executeJavaScript(
    `(() => ({
      title: document.querySelector('#profile-dialog-title')?.textContent || '',
      action: document.querySelector('.import-result-view .primary-button')?.textContent || '',
      stats: [...document.querySelectorAll('.import-result-stats > span')].map((row) => ({
        value: row.querySelector('b')?.textContent || '',
        label: row.querySelector('small')?.textContent || '',
      })),
      progress: globalThis.__chromeImportProgress || [],
    }))()`,
    true,
  );
  await writeFile(
    join(testRoot, "chrome-import-result.png"),
    await captureWebContentsPng(overviewView),
  );
  const imported = profiles.list().find((profile) => profile.kind === "imported");
  if (!imported) throw new Error("Chrome import UI did not publish a Profile");
  const importedCookies = await session
    .fromPartition(`persist:${imported.partitionId}`)
    .cookies.get({});
  const verifiedImportedCookies = chromeFixtureCookies(importedCookies);
  const originStorage = await readImportedOriginStorage(imported.partitionId);
  const copiedStorageMarkers = await readImportedStorageMarkers(
    userDataPath,
    imported.partitionId,
  );
  const originStorageVerified = {
    localStorage: originStorage.localStorage === "fixture-local-storage",
    indexedDb: originStorage.indexedDb === "fixture-indexeddb",
    opfs: originStorage.opfs === "fixture-opfs",
  };
  const copiedStorageVerified = {
    webStorage:
      copiedStorageMarkers.webStorage === "fixture-web-storage-copy",
    fileSystem:
      copiedStorageMarkers.fileSystem === "fixture-file-system-copy",
  };

  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.import-result-view .primary-button')?.click()`,
    true,
  );
  await waitUntil(
    () => manager.listSpaces().length === initialSpaceCount + 1,
    3_000,
  );
  const created = manager.listSpaces().at(-1)!;
  const removeWhileUsed = await overviewView.webContents.executeJavaScript(
    `window.xBrowser.profiles.remove(${JSON.stringify(imported.id)}).then(() => 'removed').catch((error) => String(error))`,
    true,
  );
  const syncRequested =
    process.env.X_BROWSER_TEST_CHROME_IMPORT_ENABLE_SYNC === "1";
  if (syncRequested) {
    await overviewView.webContents.executeJavaScript(
      `window.xBrowser.profiles.setSync(${JSON.stringify(imported.id)}, true)`,
      true,
    );
    await waitUntil(
      () =>
        profiles.getOrThrow(imported.id).source?.loginSyncEnabled === true,
      3_000,
    );
  }
  const syncEnabled =
    profiles.getOrThrow(imported.id).source?.loginSyncEnabled === true;
  await writeFile(
    join(testRoot, "chrome-import-ui.png"),
    await captureWebContentsPng(overviewView),
  );
  const phases = result.progress.map((progress: any) => progress.phase);
  const phaseSequence = phases.filter(
    (phase: string, index: number) => index === 0 || phase !== phases[index - 1],
  );
  const snapshotProgress = result.progress.filter(
    (progress: any) => progress.phase === "snapshotting",
  );
  const snapshotProgressMonotonic = snapshotProgress.every(
    (progress: any, index: number) =>
      index === 0 ||
      Number(progress.completed) >= Number(snapshotProgress[index - 1].completed),
  );
  const ok =
    profileHome.dialogVisible === true &&
    profileHome.profileRows === 2 &&
    profileHome.importLabel === "从 Chrome 导入登录状态" &&
    profileHome.syncNote.includes("仅在来源真正变化时更新差异") &&
    runningSource.warning === true &&
    runningSource.title === "Google Chrome 正在运行" &&
    runningSource.action === "退出 Chrome 并继续" &&
    runningSource.submitDisabled === true &&
    sourceReady.ready === true &&
    sourceReady.title === "可以开始导入" &&
    sourceReady.submitDisabled === false &&
    discoveryElapsedMs < 500 &&
    mainThreadResponsiveness.heartbeatTicks >= 5 &&
    mainThreadResponsiveness.maxStallMs < 50 &&
    discovery.title === "从 Chrome 导入" &&
    discovery.profiles.length === 1 &&
    discovery.profiles[0].name === "Fixture Personal" &&
    discovery.profiles[0].selected === true &&
    discovery.profiles[0].detail.includes("最近使用") &&
    discovery.scope.includes("仅在这台 Mac 复制") &&
    discovery.scope.includes("临时会话 Cookie 将保留 30 天") &&
    discovery.scope.includes("不会导入密码、信用卡、浏览记录或 Google 同步账号") &&
    discovery.scope.includes("Passkey、设备绑定或客户端证书网站可能需要重新登录") &&
    discovery.partialAllowed === false &&
    discovery.submitEnabled === true &&
    result.title === "登录状态已导入" &&
    result.action === "使用此 Profile 打开 Space" &&
    result.stats.some(
      (stat: any) => stat.label === "默认 Profile" && stat.value === "是",
    ) &&
    phaseSequence.join(",") ===
      "snapshotting,importing-cookies,verifying,committed" &&
    snapshotProgress.length >= 4 &&
    snapshotProgressMonotonic &&
    snapshotProgress.some(
      (progress: any) => progress.detailCode === "Local Storage",
    ) &&
    snapshotProgress.some(
      (progress: any) => progress.detailCode === "compatibility",
    ) &&
    verifiedImportedCookies.length === 2 &&
    Object.values(originStorageVerified).every(Boolean) &&
    Object.values(copiedStorageVerified).every(Boolean) &&
    profiles.getDefault().id === imported.id &&
    created.profileId === imported.id &&
    (!syncRequested || syncEnabled) &&
    String(removeWhileUsed).includes("profile-in-use");
  await writeFile(
    join(testRoot, "chrome-import-ui-audit.json"),
    `${JSON.stringify(
      {
        ok,
        profileHome,
        runningSource,
        sourceReady,
        performance: {
          discoveryElapsedMs,
          mainThreadResponsiveness,
        },
        discovery,
        result,
        importedProfile: {
          id: imported.id,
          isDefault: profiles.getDefault().id === imported.id,
          cookieCount: verifiedImportedCookies.length,
          originStorageVerified,
          copiedStorageVerified,
          syncEnabled,
        },
        createdSpace: { id: created.id, profileId: created.profileId },
        removeWhileUsed: String(removeWhileUsed).includes("profile-in-use"),
      },
      null,
      2,
    )}\n`,
  );
}

async function runProfileSyncAudit(context: {
  testRoot: string;
  userDataPath: string;
  profiles: BrowserProfileRegistry;
  profileSync: ProfileSyncService;
  profileStorageSync: ProfileStorageSyncService;
  overviewView: WebContentsView;
}) {
  const {
    testRoot,
    userDataPath,
    profiles,
    profileSync,
    profileStorageSync,
    overviewView,
  } = context;
  const imported = profiles.list().find((profile) => profile.kind === "imported");
  if (!imported) throw new Error("Profile sync audit requires an imported Profile");
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('#profile-button')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `document.querySelectorAll('.profile-row').length === 3`,
  );

  const intervalMs = 5;
  let ticks = 0;
  let maxGapMs = 0;
  let previousAt = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - previousAt);
    previousAt = now;
    ticks++;
  }, intervalMs);
  let storageStatus;
  let cookieStatus;
  try {
    storageStatus = await profileStorageSync.prepareProfile(imported.id);
    cookieStatus = await profileSync.syncProfile(imported.id, "e2e");
    // Startup may have already completed the real sync before this audit
    // attaches. Keep the heartbeat alive for a few event-loop turns so the
    // audit still detects a blocked main thread instead of reporting zero
    // samples for a correctly deduplicated no-op scan.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } finally {
    clearInterval(heartbeat);
  }

  const targetCookies = await session
    .fromPartition(`persist:${imported.partitionId}`)
    .cookies.get({});
  const cookieSynced = targetCookies.some(
    (cookie) => cookie.name === "regular" && cookie.value === "fixture-cookie-sync",
  );
  const storageMarkerSynced =
    (await readFile(
      join(
        userDataPath,
        "Partitions",
        imported.partitionId,
        "WebStorage",
        "ufo-fixture-marker",
      ),
      "utf8",
    )) === "fixture-web-storage-sync";
  const dom = await overviewView.webContents.executeJavaScript(
    `(() => {
      const row = document.querySelector(${JSON.stringify(
        `.profile-row[data-profile-id="${imported.id}"]`,
      )});
      return {
        toggleChecked: row?.querySelector('.profile-sync-toggle')?.getAttribute('aria-checked') || '',
        storageProgressSeen: document.body.dataset.profileSyncStorageSeen === '1',
        phase: document.body.dataset.profileSyncPhase || '',
        result: document.body.dataset.profileSyncResult || '',
        stripHidden: Boolean(document.querySelector('#profile-sync-strip')?.hidden),
        stripLabel: document.querySelector('#profile-sync-label')?.textContent || '',
        fillTransform: document.querySelector('#profile-sync-fill')?.style.transform || '',
      };
    })()`,
    true,
  );
  await writeFile(
    join(testRoot, "profile-sync-ui.png"),
    await captureWebContentsPng(overviewView),
  );
  const performanceAudit = {
    heartbeatTicks: ticks,
    maxGapMs: Number(maxGapMs.toFixed(1)),
    maxStallMs: Number(Math.max(0, maxGapMs - intervalMs).toFixed(1)),
  };
  const syncEnabled =
    profiles.getOrThrow(imported.id).source?.loginSyncEnabled === true;
  const ok =
    syncEnabled &&
    cookieSynced &&
    storageMarkerSynced &&
    dom.toggleChecked === "true" &&
    dom.storageProgressSeen === true &&
    dom.fillTransform === "scaleX(1)" &&
    performanceAudit.heartbeatTicks >= 2 &&
    performanceAudit.maxStallMs < 50 &&
    ["updated", "unchanged", "baselined"].includes(
      String(storageStatus?.result),
    ) &&
    ["updated", "unchanged"].includes(String(cookieStatus?.result));
  await writeFile(
    join(testRoot, "profile-sync-audit.json"),
    `${JSON.stringify(
      {
        ok,
        profileId: imported.id,
        syncEnabled,
        cookieSynced,
        storageMarkerSynced,
        storageResult: storageStatus?.result,
        cookieResult: cookieStatus?.result,
        performance: performanceAudit,
        dom,
      },
      null,
      2,
    )}\n`,
  );
}

async function seedChromeFixtureOriginStorage() {
  const chromeUserDataPath = process.env.X_BROWSER_TEST_CHROME_USER_DATA_PATH;
  const origin = process.env.X_BROWSER_TEST_CHROME_STORAGE_ORIGIN;
  if (!chromeUserDataPath || !origin) {
    throw new Error("missing isolated Chrome storage fixture configuration");
  }
  const sourceSession = session.fromPath(join(chromeUserDataPath, "Default"));
  const view = new WebContentsView({
    webPreferences: {
      session: sourceSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await view.webContents.loadURL(origin);
    const seeded = await view.webContents.executeJavaScript(
      `(() => (async () => {
        localStorage.setItem('ufo-login-state', 'fixture-local-storage');
        const indexedDb = await new Promise((resolve, reject) => {
          const request = indexedDB.open('ufo-login-state', 1);
          request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('session')) {
              request.result.createObjectStore('session');
            }
          };
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('session', 'readwrite');
            transaction.objectStore('session').put('fixture-indexeddb', 'login');
            transaction.oncomplete = () => {
              database.close();
              resolve('fixture-indexeddb');
            };
            transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
          };
        });
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle('ufo-login-state.txt', { create: true });
        const writable = await handle.createWritable();
        await writable.write('fixture-opfs');
        await writable.close();
        return {
          localStorage: localStorage.getItem('ufo-login-state'),
          indexedDb,
          opfs: await (await handle.getFile()).text(),
        };
      })())()`,
      true,
    );
    if (
      seeded.localStorage !== "fixture-local-storage" ||
      seeded.indexedDb !== "fixture-indexeddb" ||
      seeded.opfs !== "fixture-opfs"
    ) {
      throw new Error("isolated Chrome storage fixture verification failed");
    }
    sourceSession.flushStorageData();
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    view.webContents.close();
  }
}

async function diagnoseChromeImportFailure(userDataPath: string) {
  const jobsRoot = join(userDataPath, "Chrome Import", "jobs");
  const jobNames = await directoryNames(jobsRoot);
  const latestJob = jobNames.at(-1);
  if (!latestJob) return { pendingJobs: 0 };
  const manifest = JSON.parse(
    await readFile(join(jobsRoot, latestJob, "job.json"), "utf8"),
  );
  const partitionId = String(manifest?.target?.partitionId || "");
  const profileId = String(manifest?.target?.profileId || "");
  const target = await createElectronCookieWriteTarget({
    partitionsRoot: join(userDataPath, "Partitions"),
    profileId,
    partitionId,
  });
  try {
    const regular = await target.cookies.get({});
    const storage = await target.cdp.send("Network.getAllCookies");
    const storageCookies = Array.isArray(storage?.cookies) ? storage.cookies : [];
    const partitioned = storageCookies.filter((cookie: any) => cookie.partitionKey);
    const testSecret = process.env.X_BROWSER_TEST_CHROME_SAFE_STORAGE_SECRET || "";
    const expected = await readChromeCookies(
      join(jobsRoot, latestJob, "source", "Cookies"),
      new MockKeychainProvider(testSecret),
    );
    const expectedPartitioned = expected.cookies.find(
      (cookie) => cookie.partitionKey,
    );
    const actualPartitioned = partitioned[0];
    const partitionComparison =
      expectedPartitioned && actualPartitioned
        ? {
            name: actualPartitioned.name === expectedPartitioned.name,
            value: actualPartitioned.value === expectedPartitioned.value,
            domain:
              String(actualPartitioned.domain || "").replace(/^\./, "") ===
              expectedPartitioned.domain.replace(/^\./, ""),
            path: actualPartitioned.path === expectedPartitioned.path,
            secure: Boolean(actualPartitioned.secure) === expectedPartitioned.secure,
            httpOnly:
              Boolean(actualPartitioned.httpOnly) === expectedPartitioned.httpOnly,
            sameSite:
              actualPartitioned.sameSite === "None"
                ? expectedPartitioned.sameSite === "no_restriction"
                : actualPartitioned.sameSite === expectedPartitioned.sameSite,
            expirationDelta: Math.abs(
              Number(actualPartitioned.expires) -
                expectedPartitioned.expirationDate,
            ),
            topLevelSite:
              actualPartitioned.partitionKey?.topLevelSite ===
              expectedPartitioned.partitionKey?.topLevelSite,
            hasCrossSiteAncestor:
              Boolean(
                actualPartitioned.partitionKey?.hasCrossSiteAncestor,
              ) === expectedPartitioned.partitionKey?.hasCrossSiteAncestor,
          }
        : undefined;
    return {
      pendingJobs: jobNames.length,
      phase: String(manifest?.phase || ""),
      failureCode: String(manifest?.failureCode || ""),
      regular: regular.map((cookie) => ({
        hostOnly: Boolean(cookie.hostOnly),
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        session: Boolean(cookie.session),
        sameSite: cookie.sameSite,
        expirationPresent: typeof cookie.expirationDate === "number",
      })),
      partitioned: partitioned.map((cookie: any) => ({
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: String(cookie.sameSite || ""),
        expirationPresent: typeof cookie.expires === "number",
        partitionKeyPresent: Boolean(cookie.partitionKey),
        hasCrossSiteAncestor: Boolean(
          cookie.partitionKey?.hasCrossSiteAncestor,
        ),
      })),
      storageCookies: storageCookies.map((cookie: any) => ({
        keys: Object.keys(cookie).sort(),
        partitionKeyType: typeof cookie.partitionKey,
        partitionKeyPresent: Boolean(cookie.partitionKey),
        partitionKeyOpaque: Boolean(cookie.partitionKeyOpaque),
        sameParty: Boolean(cookie.sameParty),
      })),
      partitionComparison,
    };
  } finally {
    await target.dispose();
  }
}

async function runChromeImportRestartAudit(context: {
  testRoot: string;
  userDataPath: string;
  manager: TaskSpaceManager;
  profiles: BrowserProfileRegistry;
  overviewView: WebContentsView;
}) {
  const { testRoot, userDataPath, manager, profiles, overviewView } = context;
  const imported = profiles.list().find((profile) => profile.kind === "imported");
  if (!imported) throw new Error("imported Profile was not restored");
  const cookies = await session
    .fromPartition(`persist:${imported.partitionId}`)
    .cookies.get({});
  const verifiedImportedCookies = chromeFixtureCookies(cookies);
  const originStorage = await readImportedOriginStorage(imported.partitionId);
  const copiedStorageMarkers = await readImportedStorageMarkers(
    userDataPath,
    imported.partitionId,
  );
  const originStorageVerified = {
    localStorage: originStorage.localStorage === "fixture-local-storage",
    indexedDb: originStorage.indexedDb === "fixture-indexeddb",
    opfs: originStorage.opfs === "fixture-opfs",
  };
  const copiedStorageVerified = {
    webStorage:
      copiedStorageMarkers.webStorage === "fixture-web-storage-copy",
    fileSystem:
      copiedStorageMarkers.fileSystem === "fixture-file-system-copy",
  };
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('#profile-button')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `document.querySelectorAll('.profile-row').length === 3`,
  );
  await writeFile(
    join(testRoot, "chrome-import-restart.png"),
    await captureWebContentsPng(overviewView),
  );
  const dom = await overviewView.webContents.executeJavaScript(
    `(() => ({
      profiles: [...document.querySelectorAll('.profile-row')].map((row) => ({
        name: row.querySelector('strong')?.textContent || '',
        selected: row.classList.contains('selected'),
      })),
      headerProfile: document.querySelector('#profile-button-label')?.textContent || '',
    }))()`,
    true,
  );
  const importedSpaces = manager
    .listSpaces()
    .filter((space) => space.profileId === imported.id);
  const ok =
    verifiedImportedCookies.length === 2 &&
    Object.values(originStorageVerified).every(Boolean) &&
    Object.values(copiedStorageVerified).every(Boolean) &&
    profiles.getDefault().id === imported.id &&
    importedSpaces.length === 1 &&
    dom.profiles.length === 3 &&
    dom.headerProfile === imported.name;
  await writeFile(
    join(testRoot, "chrome-import-restart-audit.json"),
    `${JSON.stringify(
      {
        ok,
        importedProfile: {
          id: imported.id,
          name: imported.name,
          cookieCount: verifiedImportedCookies.length,
          originStorageVerified,
          copiedStorageVerified,
        },
        importedSpaceIds: importedSpaces.map((space) => space.id),
        dom,
      },
      null,
      2,
    )}\n`,
  );
}

async function readImportedOriginStorage(partitionId: string) {
  const origin = process.env.X_BROWSER_TEST_CHROME_STORAGE_ORIGIN;
  if (!origin) throw new Error("missing Chrome storage fixture origin");
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:${partitionId}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await view.webContents.loadURL(origin);
    return await view.webContents.executeJavaScript(
      `(() => (async () => {
        const indexedDb = await new Promise((resolve) => {
          const request = indexedDB.open('ufo-login-state');
          request.onerror = () => resolve(null);
          request.onsuccess = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains('session')) {
              database.close();
              resolve(null);
              return;
            }
            const transaction = database.transaction('session', 'readonly');
            const get = transaction.objectStore('session').get('login');
            get.onerror = () => {
              database.close();
              resolve(null);
            };
            get.onsuccess = () => {
              const value = get.result ?? null;
              database.close();
              resolve(value);
            };
          };
        });
        let opfs = null;
        try {
          const root = await navigator.storage.getDirectory();
          const handle = await root.getFileHandle('ufo-login-state.txt');
          opfs = await (await handle.getFile()).text();
        } catch {}
        return {
          localStorage: localStorage.getItem('ufo-login-state'),
          indexedDb,
          opfs,
        };
      })())()`,
      true,
    );
  } finally {
    view.webContents.close();
  }
}

async function readImportedStorageMarkers(
  userDataPath: string,
  partitionId: string,
) {
  const partitionPath = join(userDataPath, "Partitions", partitionId);
  return {
    webStorage: await readFile(
      join(partitionPath, "WebStorage", "ufo-fixture-marker"),
      "utf8",
    ),
    fileSystem: await readFile(
      join(partitionPath, "File System", "ufo-fixture-marker"),
      "utf8",
    ),
  };
}

async function runChromeImportRollbackAudit(context: {
  testRoot: string;
  profiles: BrowserProfileRegistry;
  overviewView: WebContentsView;
}) {
  const { testRoot, profiles, overviewView } = context;
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('#profile-button')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `Boolean(document.querySelector('.import-command'))`,
  );
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.import-command')?.click()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `Boolean(document.querySelector('.chrome-import-form'))`,
  );
  await overviewView.webContents.executeJavaScript(
    `document.querySelector('.chrome-import-form')?.requestSubmit()`,
    true,
  );
  await waitForRenderer(
    overviewView,
    `Boolean(document.querySelector('.dialog-error-view'))`,
    12_000,
  );
  const dom = await overviewView.webContents.executeJavaScript(
    `(() => ({
      title: document.querySelector('#profile-dialog-title')?.textContent || '',
      error: document.querySelector('.dialog-error-view strong')?.textContent || '',
      action: document.querySelector('.dialog-error-view button')?.textContent || '',
    }))()`,
    true,
  );
  await writeFile(
    join(testRoot, "chrome-import-rollback.png"),
    await captureWebContentsPng(overviewView),
  );
  const ok =
    profiles.list().length === 1 &&
    profiles.getDefault().id === "default" &&
    dom.error === "无法解密 Chrome Cookie，现有 UFO-Browser 数据未受影响";
  await writeFile(
    join(testRoot, "chrome-import-rollback-audit.json"),
    `${JSON.stringify({ ok, profileCount: profiles.list().length, dom }, null, 2)}\n`,
  );
}

async function runChromeImportRollbackRecoveryAudit(context: {
  testRoot: string;
  userDataPath: string;
  profiles: BrowserProfileRegistry;
}) {
  const { testRoot, userDataPath, profiles } = context;
  const partitionNames = await directoryNames(join(userDataPath, "Partitions"));
  const jobNames = await directoryNames(join(userDataPath, "Chrome Import", "jobs"));
  const leakedPartitions = partitionNames.filter((name) =>
    name.startsWith("x-browser-profile-chrome-"),
  );
  const ok =
    profiles.list().length === 1 &&
    profiles.getDefault().id === "default" &&
    leakedPartitions.length === 0 &&
    jobNames.length === 0;
  await writeFile(
    join(testRoot, "chrome-import-rollback-recovery-audit.json"),
    `${JSON.stringify(
      {
        ok,
        profileCount: profiles.list().length,
        leakedPartitionCount: leakedPartitions.length,
        pendingJobCount: jobNames.length,
      },
      null,
      2,
    )}\n`,
  );
}

function chromeFixtureCookies(cookies: Array<{ name?: string; domain?: string }>) {
  return cookies.filter((cookie) => {
    const domain = String(cookie.domain || "").replace(/^\./, "");
    return (
      (cookie.name === "regular" && domain === "fixture.example") ||
      (cookie.name === "partitioned" && domain === "chips.fixture.example")
    );
  });
}

async function waitForRenderer(
  view: WebContentsView,
  expression: string,
  timeoutMs = 4_000,
) {
  return waitUntil(
    async () =>
      Boolean(await view.webContents.executeJavaScript(expression, true)),
    timeoutMs,
  );
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("timed out waiting for Chrome import audit state");
}

async function directoryNames(path: string) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function captureVisibleTestViews(context: {
  testRoot: string;
  manager: TaskSpaceManager;
  chatView: WebContentsView;
  overviewView: WebContentsView;
  browserView: WebContentsView;
}, suffix = "") {
  const { testRoot, manager, chatView, overviewView, browserView } = context;
  await writeFile(
    join(testRoot, `preview-main${suffix}.json`),
    `${JSON.stringify(manager.previewDiagnostics(), null, 2)}\n`,
  );
  const chatBounds = chatView.getBounds();
  if (
    chatView.getVisible() &&
    chatBounds.width > 0 &&
    chatBounds.height > 0
  ) {
    await writeFile(
      join(testRoot, "chat.png"),
      await captureWebContentsPng(chatView),
    );
  }
  if (overviewView.getVisible()) {
    await writeFile(
      join(testRoot, `overview${suffix}.png`),
      await captureWebContentsPng(overviewView),
    );
    const previewState = await overviewView.webContents.executeJavaScript(
      `(() => ({
        canvases: [...document.querySelectorAll('.preview-canvas')].map((canvas) => {
          const card = canvas.closest('[data-space-id]');
          const preview = card?.querySelector('.space-preview');
          const previewRect = preview?.getBoundingClientRect();
          let signature = '';
          if (canvas.classList.contains('ready') && canvas.width > 0 && canvas.height > 0) {
            const probe = document.createElement('canvas');
            probe.width = 16;
            probe.height = 16;
            const context = probe.getContext('2d', { willReadFrequently: true });
            context?.drawImage(canvas, 0, 0, 16, 16);
            const pixels = context?.getImageData(0, 0, 16, 16).data || [];
            let hash = 2166136261;
            for (let index = 0; index < pixels.length; index += 1) {
              hash ^= pixels[index];
              hash = Math.imul(hash, 16777619);
            }
            signature = (hash >>> 0).toString(16).padStart(8, '0');
          }
          return {
            spaceId: Number(card?.dataset.spaceId),
            width: canvas.width,
            height: canvas.height,
            cssWidth: previewRect?.width || 0,
            cssHeight: previewRect?.height || 0,
            ready: canvas.classList.contains('ready'),
            signature,
          };
        }),
        chrome: [...document.querySelectorAll('.preview-browser-chrome')].map((node) => ({
          tabs: node.querySelectorAll('.preview-tab').length,
          activeTabs: node.querySelectorAll('.preview-tab.active').length,
          address: node.querySelector('.preview-address em')?.textContent || '',
        })),
        placeholders: document.querySelectorAll('.preview-placeholder').length,
        receivedFrames: Number(document.body.dataset.previewFrames || 0),
        previewError: document.body.dataset.previewError || null,
        layout: {
          visibilityState: document.visibilityState,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          scrollY: window.scrollY,
          visibilityPublishes: Number(document.body.dataset.visibilityPublishes || 0),
          visibilityRequest: document.body.dataset.visibilityRequest || '',
          visibilityAck: document.body.dataset.visibilityAck || '',
          visibilityError: document.body.dataset.visibilityError || null,
          cards: [...document.querySelectorAll('[data-space-id]')].map((card) => {
            const rect = card.getBoundingClientRect();
            return {
              id: Number(card.dataset.spaceId),
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            };
          }),
        },
      }))()`,
      true,
    );
    await writeFile(
      join(testRoot, `preview-state${suffix}.json`),
      `${JSON.stringify({ renderer: previewState, main: manager.previewDiagnostics() }, null, 2)}\n`,
    );
  }
  if (browserView.getVisible()) {
    await writeFile(
      join(testRoot, `browser${suffix}.png`),
      await captureWebContentsPng(browserView),
    );
  }
}

function testPreviewDiagnostics(
  manager: TaskSpaceManager,
  context?: {
    window: BaseWindow;
    captureWindow: BaseWindow;
    presentation: PresentationCoordinator;
    chatView: WebContentsView;
    overviewView: WebContentsView;
    browserView: WebContentsView;
    overlayView: WebContentsView;
  },
) {
  const shellViews = context
    ? new Map<WebContentsView, string>([
        [context.chatView, "chat"],
        [context.overviewView, "overview"],
        [context.browserView, "browser"],
        [context.overlayView, "overlay"],
      ])
    : undefined;
  const pageViews = new Map<WebContentsView, string>();
  if (context) {
    for (const space of manager.listSpaces()) {
      for (const tab of space.tabs) {
        const view = manager.getView(tab.targetId);
        if (view) pageViews.set(view, `page:${space.id}:${tab.targetId}`);
      }
    }
  }
  const rootChildren = context
    ? context.window.contentView.children.map((child) => {
        const shellName = shellViews?.get(child as WebContentsView);
        if (shellName) return shellName;
        return pageViews.get(child as WebContentsView) ?? "unknown";
      })
    : [];
  return {
    ...manager.previewDiagnostics(),
    app: context
      ? {
          presentation: context.presentation.current(),
          mainWindow: {
            visible: context.window.isVisible(),
            focused: context.window.isFocused(),
            rootChildren,
          },
          backgroundSurfaceWindow: {
            visible: context.captureWindow.isVisible(),
            focused: context.captureWindow.isFocused(),
            focusable: context.captureWindow.isFocusable(),
            opacity: context.captureWindow.getOpacity(),
            hasShadow: context.captureWindow.hasShadow(),
            resizable: context.captureWindow.isResizable(),
            minimizable: context.captureWindow.isMinimizable(),
            maximizable: context.captureWindow.isMaximizable(),
            fullscreenable: context.captureWindow.isFullScreenable(),
            childCount: context.captureWindow.contentView.children.length,
          },
        }
      : undefined,
    processMetrics: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      serviceName: metric.serviceName,
      name: metric.name,
      cpu: metric.cpu,
      memory: metric.memory,
    })),
  };
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
