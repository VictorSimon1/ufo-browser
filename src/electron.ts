import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  app,
  BaseWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  WebContentsView,
} from "electron";
import { AgentServer } from "./main/agent-server.js";
import { CdpBroker } from "./main/cdp-broker.js";
import { TaskSpaceManager } from "./main/manager.js";
import { PresentationCoordinator } from "./main/presentation-coordinator.js";
import { SnapshotService } from "./main/snapshot.js";
import { SpaceLeaseRegistry } from "./main/space-lease.js";
import { BrowserStateStore } from "./main/state-store.js";
import { ClaudeSessionManager } from "./main/claude-chat/manager.js";
import { visibleSpaceIds } from "./main/preview-visibility.js";
import { BROWSER_CHROME_HEIGHT } from "./main/shell-page-bounds.js";
import type { Rect } from "./main/types.js";
import {
  chromiumAcceptLanguages,
  reducedChromiumUserAgent,
} from "./main/chromium-identity.js";

const isTestApp = process.env.X_BROWSER_TEST_APP === "1";
let appIsQuitting = false;
app.on("before-quit", () => {
  appIsQuitting = true;
});
const projectRoot = app.getAppPath();
const testNamespace = String(process.env.X_BROWSER_TEST_NAMESPACE || "")
  .replace(/[^a-zA-Z0-9_-]/g, "")
  .slice(0, 64);
const testRoot = testNamespace
  ? join(projectRoot, ".x-browser-test", "runs", testNamespace)
  : join(projectRoot, ".x-browser-test");
if (isTestApp) app.setPath("userData", join(testRoot, "user-data"));

app.setName("X-Browser");
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
      console.error("X-Browser failed to start", error);
      app.quit();
    });
}

async function start() {
  const traceStart = (stage: string) => {
    if (isTestApp) console.error(`[X-Browser start] ${stage}`);
  };
  traceStart("begin");
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
    title: "X-Browser",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: "#f6f9f8",
  });

  const captureWindow = new BaseWindow({
    width: 1200,
    height: 790,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    skipTaskbar: true,
  });
  captureWindow.setOpacity(0);
  captureWindow.setIgnoreMouseEvents(true);

  const shellPreferences = {
    preload: shellPreload,
    contextIsolation: true,
    nodeIntegration: false,
    // Overview visibility publication and Browser chrome state must keep
    // advancing when another Electron instance temporarily owns focus. This
    // is especially important for isolated E2E runs next to the user's
    // persistent preview App; Chromium otherwise occludes the shell renderer
    // and can defer its first visibility timer indefinitely.
    backgroundThrottling: false,
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

  const store = new BrowserStateStore(join(app.getPath("userData"), "browser-state.json"));
  const manager = new TaskSpaceManager({
    store,
    partitionsRoot: join(app.getPath("userData"), "Partitions"),
    pagePreload,
    newTabFile: renderer("newtab.html"),
    captureWindow,
    forcedPreviewSpaceId:
      isTestApp && Number.isSafeInteger(requestedOverviewSpaceId)
        ? requestedOverviewSpaceId
        : undefined,
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
  traceStart("manager-initialized");
  if (manager.listSpaces().length === 0) {
    await manager.createSpace("Welcome Space", "user");
  }

  const leases = new SpaceLeaseRegistry();
  const snapshot = new SnapshotService(manager);
  const broker = new CdpBroker(manager, leases);
  const socketPath = isTestApp
    ? join(testRoot, "x-browser.sock")
    : join(app.getPath("userData"), "x-browser.sock");
  const server = new AgentServer(socketPath, manager, leases, snapshot, broker);
  const assistantWorkspace = join(app.getPath("userData"), "Assistant Workspace");
  const skillSource = app.isPackaged
    ? join(process.resourcesPath, "skills/x-browser")
    : join(projectRoot, "skills/x-browser");
  await mkdir(join(assistantWorkspace, ".claude/skills"), {
    recursive: true,
    mode: 0o700,
  });
  await cp(skillSource, join(assistantWorkspace, ".claude/skills/x-browser"), {
    recursive: true,
    force: true,
  });
  traceStart("skill-synced");
  const claude = new ClaudeSessionManager({
    claudePath: process.env.X_BROWSER_CLAUDE_PATH || "claude",
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
  );
  manager.onActiveTabChanged((spaceId) => {
    const current = presentation.current();
    if (current.kind !== "space" || current.spaceId !== spaceId) return;
    return presentation.refreshSpace(spaceId).catch(() => undefined);
  });
  manager.onAgentPointer((spaceId, pointer) =>
    presentation.showAgentPointer(spaceId, pointer),
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
    claude,
  });
  traceStart("ipc-registered");
  claude.onEvent((event) =>
    chatView.webContents.send("x-browser:chat-event", event),
  );

  const publish = () => {
    const spaces = manager.listSpaces();
    overviewView.webContents.send("x-browser:spaces-changed", spaces);
    const current = presentation.current();
    if (current.kind === "space") {
      browserView.webContents.send(
        "x-browser:browser-state",
        manager.navigationState(current.spaceId),
      );
    }
    presentation.refreshControlOverlay();
  };
  manager.onChanged(publish);
  manager.onControlChanged(publish);

  await Promise.all([
    chatView.webContents.loadFile(renderer("chat.html")),
    overviewView.webContents.loadFile(renderer("overview.html")),
    browserView.webContents.loadFile(renderer("browser.html")),
    overlayView.webContents.loadFile(renderer("agent-overlay.html")),
  ]);
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
      // The live-preview audit targets a card that can be far below the first
      // viewport. DOM scrolling is still exercised above, while the explicit
      // visibility publication removes timer/layout nondeterminism from the
      // native screencast lifecycle assertion.
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
    }, 1500);
  }

  if (isTestApp) {
    await mkdir(testRoot, { recursive: true });
    await writeFile(join(testRoot, "socket-path"), `${socketPath}\n`);
    await writeFile(join(testRoot, "pid"), `${process.pid}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await writeFile(
      join(testRoot, "preview-main-initial.json"),
      `${JSON.stringify(testPreviewDiagnostics(manager), null, 2)}\n`,
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

  if (isTestApp && process.env.X_BROWSER_TEST_INTERACTION_AUDIT === "1") {
    setTimeout(() => {
      void runBrowserInteractionAudit({
        testRoot,
        window,
        manager,
        presentation,
        browserView,
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
      void runSpaceUiAudit({ testRoot, manager, overviewView }).catch(
        async (error) => {
          await writeFile(
            join(testRoot, "space-ui-audit.json"),
            `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
          ).catch(() => undefined);
        },
      );
    }, 500);
  }

  if (isTestApp && process.env.X_BROWSER_TEST_CONTROL_UI_AUDIT === "1") {
    setTimeout(() => {
      void runControlUiAudit({
        testRoot,
        window,
        manager,
        presentation,
        browserView,
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
        `${JSON.stringify(testPreviewDiagnostics(manager), null, 2)}\n`,
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
    if (testDiagnosticsTimer) clearInterval(testDiagnosticsTimer);
    captureWindow.close();
    void server
      .close()
      .catch(() => undefined)
      .finally(() => app.quit());
  });
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
  claude: ClaudeSessionManager;
};

function registerIpc(context: IpcContext) {
  const { manager, presentation, leases, shellIds, browserView } = context;
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
  shell("x-browser:overview:create", async (_event, name?: string) => {
    const space = await manager.createSpace(name || `Space ${manager.listSpaces().length + 1}`, "user");
    await presentation.showSpace(space.id);
    browserView.webContents.send("x-browser:browser-state", manager.navigationState(space.id));
    return space;
  });
  shell("x-browser:overview:open", async (_event, spaceId: number) => {
    await presentation.showSpace(assertSpaceId(spaceId));
    browserView.webContents.send(
      "x-browser:browser-state",
      manager.navigationState(spaceId),
    );
  });
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
    return manager.navigate(spaceId, String(input));
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

function previewRect(value: unknown): Rect {
  const rect = (value ?? {}) as Partial<Rect>;
  return {
    x: finiteNumber(rect.x),
    y: finiteNumber(rect.y),
    width: Math.max(0, finiteNumber(rect.width)),
    height: Math.max(0, finiteNumber(rect.height)),
  };
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
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

async function runBrowserInteractionAudit(context: {
  testRoot: string;
  window: BaseWindow;
  manager: TaskSpaceManager;
  presentation: PresentationCoordinator;
  browserView: WebContentsView;
}) {
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
    // Give the Overview enough time to begin a live preview so returning to
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
  overviewView: WebContentsView;
  overlayView: WebContentsView;
}) {
  const {
    testRoot,
    window,
    manager,
    presentation,
    browserView,
    overviewView,
    overlayView,
  } = context;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const space = await manager.createSpace("Agent control UI audit", "agent");
  try {
    await manager.setAgentTaskState(space.id, "正在检查页面状态");
    await manager.navigate(
      space.id,
      `data:text/html;charset=utf-8,${encodeURIComponent(`
        <!doctype html><meta charset="utf-8"><title>Agent UI Audit</title>
        <style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f4f5f3;color:#2d3532;font:16px -apple-system}.card{width:420px;padding:38px;border:1px solid #dce2df;border-radius:24px;background:#fff;box-shadow:0 24px 70px rgba(36,52,45,.1)}button{padding:12px 18px;border:0;border-radius:12px;background:#173d32;color:#fff}</style>
        <main class="card"><h1>Agent is browsing</h1><p>The page remains visible while X-Browser protects user input.</p><button onclick="window.clickCount=(window.clickCount||0)+1">Continue</button></main>
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

    const chrome = await browserView.webContents.executeJavaScript(
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
      focused: overlayView.webContents.isFocused(),
    };
    const pageButton = await view.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('main button');
        const rect = button?.getBoundingClientRect();
        return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
      })()`,
      true,
    );
    if (!pageButton) throw new Error("control audit button missing");
    if (!view.webContents.debugger.isAttached()) view.webContents.debugger.attach("1.3");
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
    await wait(80);
    const agentClickCount = await view.webContents.executeJavaScript(
      `Number(window.clickCount || 0)`,
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
    const pageIsolation = await view.webContents.executeJavaScript(
      `({ overlayNode: Boolean(document.getElementById('__x_browser_agent_overlay')) })`,
      true,
    );
    await writeFile(join(testRoot, "control-ui-chrome.png"), await captureWebContentsPng(browserView));
    await writeFile(join(testRoot, "control-ui-page.png"), await captureWebContentsPng(view));
    await writeFile(join(testRoot, "control-ui-overlay.png"), await captureWebContentsPng(overlayView));

    await browserView.webContents.executeJavaScript(
      "document.querySelector('#spaces-button')?.click()",
      true,
    );
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

    const ok =
      chrome.controlled === true &&
      chrome.lockVisible === true &&
      chrome.spacesCount === "2" &&
      /共 2 个/.test(chrome.spacesLabel || "") &&
      backgroundBeforePresentation.overlayAttached === false &&
      backgroundBeforePresentation.pageOverlayPresent === false &&
      nativeOverlay.attached === true &&
      nativeOverlay.topmost === true &&
      nativeOverlay.bounds.y === BROWSER_CHROME_HEIGHT &&
      nativeOverlay.bounds.width > 0 &&
      nativeOverlay.bounds.height > 0 &&
      nativeOverlay.focused === true &&
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
      returned.runtimePreserved === true;
    await writeFile(
      join(testRoot, "control-ui-audit.json"),
      `${JSON.stringify({ ok, chrome, backgroundBeforePresentation, nativeOverlay, overlay, pageIsolation, agentClickCount, humanAttemptClickCount, motionPreference, animationAdvanced, backgroundAfterReturn, returned }, null, 2)}\n`,
    );
  } finally {
    await presentation.showOverview().catch(() => undefined);
    await manager.closeSpace(space.id).catch(() => undefined);
  }
}

async function runSpaceUiAudit(context: {
  testRoot: string;
  manager: TaskSpaceManager;
  overviewView: WebContentsView;
}) {
  const { testRoot, manager, overviewView } = context;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const initial = manager.listSpaces()[0];
  if (!initial) throw new Error("space UI audit requires one Space");
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
  await writeFile(
    join(testRoot, "space-menu.png"),
    await captureWebContentsPng(overviewView),
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
      const plus = create?.querySelector(':scope > span');
      return {
        titleX: title?.getBoundingClientRect().x || 0,
        previewRadius: preview ? getComputedStyle(preview).borderRadius : '',
        previewShadow: preview ? getComputedStyle(preview).boxShadow : '',
        createRadius: create ? getComputedStyle(create).borderRadius : '',
        plusBorder: plus ? getComputedStyle(plus).borderStyle : '',
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
  const ok =
    menu.card === true &&
    menu.expanded === "true" &&
    menu.hidden === false &&
    menu.items === 2 &&
    renameStarted.renaming === true &&
    renameStarted.focused === true &&
    renameStarted.value === initial.name &&
    storedName === renamedValue &&
    finalDom.renaming === false &&
    finalDom.title === renamedValue &&
    finalDom.menuHidden === true &&
    visualBefore.previewRadius === "18px" &&
    visualBefore.createRadius === "18px" &&
    visualBefore.plusBorder === "none" &&
    controlledVisual.controlled === "1" &&
    controlledVisual.runningChipPresent === false &&
    controlledVisual.dotWidth === "5px" &&
    controlledVisual.dotDisplay === "inline-block" &&
    controlledVisual.frameDisplay === "block" &&
    controlledVisual.frameBorderWidth === "2px" &&
    controlledVisual.frameAnimation === "agent-card-frame-breathe" &&
    Math.abs(controlledVisual.titleX - visualBefore.titleX) < 0.5 &&
    controlledVisual.previewShadow !== visualBefore.previewShadow;
  await manager.renameSpace(initial.id, initial.name);
  await writeFile(
    join(testRoot, "space-ui-audit.json"),
    `${JSON.stringify(
      {
        ok,
        menu,
        renameStarted,
        storedName,
        finalDom,
        visualBefore,
        controlledVisual,
      },
      null,
      2,
    )}\n`,
  );
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

function testPreviewDiagnostics(manager: TaskSpaceManager) {
  return {
    ...manager.previewDiagnostics(),
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
