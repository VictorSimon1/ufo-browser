import { session, WebContentsView, type Session } from "electron";
import { join } from "node:path";
import {
  configureChromiumSession,
  ensureChromiumProfilePreferences,
} from "../chromium-identity.js";
import type { CookieWriteTarget } from "./cookie-writer.js";
import {
  CHROME_STORAGE_PATHS,
  inspectChromeStorageSnapshot,
  removeFailedStoragePaths,
  type ChromeStorageInspection,
  type ChromeStoragePath,
  type StoragePreflightResult,
} from "./storage-preflight.js";

const STORAGE_PREFLIGHT_ORIGIN = "https://ufo-storage-preflight.invalid";
const STORAGE_PREFLIGHT_ORIGIN_LIMIT = 32;
const STORAGE_PREFLIGHT_TIMEOUT_MS = 8_000;
const STORAGE_PREFLIGHT_NAVIGATION_TIMEOUT_MS = 1_500;
const STORAGE_PATH_SET = new Set<string>(CHROME_STORAGE_PATHS);

export async function createElectronCookieWriteTarget(options: {
  partitionsRoot: string;
  profileId: string;
  partitionId: string;
  copiedStorage?: readonly string[];
}): Promise<CookieWriteTarget> {
  const copiedStorage = [...(options.copiedStorage ?? [])].filter(
    (value): value is ChromeStoragePath => STORAGE_PATH_SET.has(value),
  );
  const partitionPath = join(options.partitionsRoot, options.partitionId);
  let inspection: ChromeStorageInspection;
  try {
    inspection = await inspectChromeStorageSnapshot(
      partitionPath,
      copiedStorage,
    );
  } catch {
    inspection = {
      failed: copiedStorage,
      warningCodes: ["origin-storage-preflight-failed"],
      origins: { localStorage: [], indexedDb: [], quota: [] },
    };
  }
  await removeFailedStoragePaths(partitionPath, inspection.failed);
  await ensureChromiumProfilePreferences(
    options.partitionsRoot,
    options.profileId,
    options.partitionId,
  );
  const partition = `persist:${options.partitionId}`;
  const chromiumSession = session.fromPartition(partition);
  await configureChromiumSession(chromiumSession);
  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
  await view.webContents.loadURL("about:blank");
  view.webContents.debugger.attach("1.3");
  let disposed = false;
  let storagePreflight: Promise<StoragePreflightResult> | undefined;
  return {
    cookies: chromiumSession.cookies,
    cdp: {
      send: (method, params) =>
        view.webContents.debugger.sendCommand(method, params),
    },
    preflightStorage: () => {
      storagePreflight ??= preflightOriginStorage(
        chromiumSession,
        partition,
        copiedStorage,
        inspection,
      );
      return storagePreflight;
    },
    flush: async () => {
      await chromiumSession.cookies.flushStore();
      chromiumSession.flushStorageData();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (view.webContents.debugger.isAttached()) {
        view.webContents.debugger.detach();
      }
      view.webContents.close();
    },
  };
}

async function preflightOriginStorage(
  chromiumSession: Session,
  partition: string,
  copiedStorage: readonly ChromeStoragePath[],
  inspection: ChromeStorageInspection,
): Promise<StoragePreflightResult> {
  const failed = new Set<ChromeStoragePath>(inspection.failed);
  const warningCodes = new Set(inspection.warningCodes);
  const remaining = copiedStorage.filter((path) => !failed.has(path));
  if (remaining.length === 0) {
    return { failed: [...failed], warningCodes: [...warningCodes] };
  }

  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
  const runtimeFailures = new Set<ChromeStoragePath>();
  try {
    await probeChromiumStorage(view, remaining, inspection, runtimeFailures);
  } catch {
    for (const path of remaining) runtimeFailures.add(path);
    warningCodes.add("origin-storage-preflight-failed");
  } finally {
    view.webContents.close();
  }

  for (const path of runtimeFailures) failed.add(path);
  addRuntimeWarningCodes(runtimeFailures, warningCodes);
  try {
    await clearSyntheticPreflightStorage(chromiumSession);
    await clearFailedStorage(chromiumSession, runtimeFailures);
  } catch {
    throw new Error("Chrome storage preflight cleanup failed");
  }
  return { failed: [...failed], warningCodes: [...warningCodes] };
}

async function clearSyntheticPreflightStorage(chromiumSession: Session) {
  await chromiumSession.clearStorageData({
    origin: STORAGE_PREFLIGHT_ORIGIN,
    storages: [
      "filesystem",
      "indexdb",
      "localstorage",
      "serviceworkers",
      "cachestorage",
    ],
  });
}

async function probeChromiumStorage(
  view: WebContentsView,
  copiedStorage: readonly ChromeStoragePath[],
  inspection: ChromeStorageInspection,
  failures: Set<ChromeStoragePath>,
) {
  const copied = new Set(copiedStorage);
  await withTimeout(
    view.webContents.loadURL("about:blank"),
    STORAGE_PREFLIGHT_TIMEOUT_MS,
  );
  view.webContents.debugger.attach("1.3");
  const debuggerApi = view.webContents.debugger;
  const responseBody = Buffer.from(
    "<!doctype html><meta charset=utf-8><title>UFO storage preflight</title>",
  ).toString("base64");
  const pausedRequestIds = new Set<string>();
  const onMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, any>,
  ) => {
    if (method !== "Fetch.requestPaused" || !params.requestId) return;
    const requestId = String(params.requestId);
    pausedRequestIds.add(requestId);
    void debuggerApi
      .sendCommand("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "content-type", value: "text/html; charset=utf-8" },
          { name: "cache-control", value: "no-store" },
        ],
        body: responseBody,
      })
      .then(
        () => pausedRequestIds.delete(requestId),
        async () => {
          await debuggerApi
            .sendCommand("Fetch.failRequest", {
              requestId,
              errorReason: "Aborted",
            })
            .catch(() => undefined);
          pausedRequestIds.delete(requestId);
        },
      );
  };
  debuggerApi.on("message", onMessage);
  try {
    await debuggerApi.sendCommand("Network.enable");
    await debuggerApi.sendCommand("Network.setBypassServiceWorker", {
      bypass: true,
    });
    await debuggerApi.sendCommand("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    const localOrigins = new Set(inspection.origins.localStorage);
    const indexedOrigins = new Set(inspection.origins.indexedDb);
    const quotaOrigins = new Set(inspection.origins.quota);
    const quotaPaths = [
      "WebStorage",
      "Storage",
      "QuotaManager",
      "QuotaManager-journal",
    ] as const;
    const probeQuota =
      quotaPaths.some((path) => copied.has(path)) || copied.has("File System");
    const origins = [
      ...new Set([...localOrigins, ...indexedOrigins, ...quotaOrigins]),
    ].slice(0, STORAGE_PREFLIGHT_ORIGIN_LIMIT);
    const usedSyntheticOrigin = origins.length === 0;
    if (usedSyntheticOrigin) origins.push(STORAGE_PREFLIGHT_ORIGIN);
    const deadline = Date.now() + STORAGE_PREFLIGHT_TIMEOUT_MS;
    for (const [index, origin] of origins.entries()) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        for (const path of copied) failures.add(path);
        break;
      }
      const result = await navigateAndProbe(
        view,
        origin,
        {
          localStorage:
            copied.has("Local Storage") && localOrigins.has(origin),
          indexedDb: copied.has("IndexedDB") && indexedOrigins.has(origin),
          quota:
            probeQuota && (quotaOrigins.has(origin) || usedSyntheticOrigin),
          fileSystem: copied.has("File System") && index === 0,
          serviceWorker: copied.has("Service Worker") && index === 0,
        },
        Math.min(STORAGE_PREFLIGHT_NAVIGATION_TIMEOUT_MS, remainingMs),
      ).catch(() => undefined);
      if (!result) {
        if (copied.has("Local Storage") && localOrigins.has(origin)) {
          failures.add("Local Storage");
        }
        if (copied.has("IndexedDB") && indexedOrigins.has(origin)) {
          failures.add("IndexedDB");
        }
        if (probeQuota && (quotaOrigins.has(origin) || usedSyntheticOrigin)) {
          for (const path of copied) failures.add(path);
        }
        if (copied.has("File System") && index === 0) {
          failures.add("File System");
        }
        if (copied.has("Service Worker") && index === 0) {
          failures.add("Service Worker");
        }
        continue;
      }
      if (result.localStorage === false) failures.add("Local Storage");
      if (result.indexedDb === false) failures.add("IndexedDB");
      if (result.quota === false) {
        for (const path of copied) failures.add(path);
      }
      if (result.fileSystem === false) failures.add("File System");
      if (result.serviceWorker === false) failures.add("Service Worker");
    }
  } finally {
    await Promise.all(
      [...pausedRequestIds].map((requestId) =>
        debuggerApi
          .sendCommand("Fetch.failRequest", {
            requestId,
            errorReason: "Aborted",
          })
          .catch(() => undefined),
      ),
    );
    pausedRequestIds.clear();
    await debuggerApi.sendCommand("Fetch.disable").catch(() => undefined);
    debuggerApi.off("message", onMessage);
    if (debuggerApi.isAttached()) debuggerApi.detach();
  }
}

async function navigateAndProbe(
  view: WebContentsView,
  origin: string,
  requested: {
    localStorage: boolean;
    indexedDb: boolean;
    quota: boolean;
    fileSystem: boolean;
    serviceWorker: boolean;
  },
  timeoutMs: number,
) {
  const url = new URL("/.well-known/ufo-storage-preflight", origin).toString();
  await withTimeout(
    view.webContents.loadURL(url),
    timeoutMs,
  );
  return withTimeout(
    view.webContents.executeJavaScript(
      `(() => (async () => {
        const requested = ${JSON.stringify(requested)};
        const result = {};
        if (requested.localStorage) {
          try { result.localStorage = localStorage.length > 0; }
          catch { result.localStorage = false; }
        }
        if (requested.indexedDb) {
          try { result.indexedDb = (await indexedDB.databases()).length > 0; }
          catch { result.indexedDb = false; }
        }
        if (requested.quota) {
          try { await navigator.storage.estimate(); result.quota = true; }
          catch { result.quota = false; }
        }
        if (requested.fileSystem) {
          try { await navigator.storage.getDirectory(); result.fileSystem = true; }
          catch { result.fileSystem = false; }
        }
        if (requested.serviceWorker) {
          try { await navigator.serviceWorker.getRegistrations(); result.serviceWorker = true; }
          catch { result.serviceWorker = false; }
        }
        return result;
      })())()`,
      true,
    ) as Promise<Record<string, boolean>>,
    timeoutMs,
  );
}

async function clearFailedStorage(
  chromiumSession: Session,
  failed: ReadonlySet<ChromeStoragePath>,
) {
  const storages = new Set<
    "filesystem" | "indexdb" | "localstorage" | "serviceworkers" | "cachestorage"
  >();
  if (failed.has("Local Storage")) storages.add("localstorage");
  if (failed.has("IndexedDB")) storages.add("indexdb");
  if (failed.has("File System")) storages.add("filesystem");
  if (failed.has("Service Worker")) {
    storages.add("serviceworkers");
    storages.add("cachestorage");
  }
  if (
    ["WebStorage", "Storage", "QuotaManager", "QuotaManager-journal"].some(
      (path) => failed.has(path as ChromeStoragePath),
    )
  ) {
    for (const storage of [
      "filesystem",
      "indexdb",
      "localstorage",
      "serviceworkers",
      "cachestorage",
    ] as const) {
      storages.add(storage);
    }
  }
  if (storages.size > 0) {
    await chromiumSession.clearStorageData({ storages: [...storages] });
  }
}

function addRuntimeWarningCodes(
  failed: ReadonlySet<ChromeStoragePath>,
  warningCodes: Set<string>,
) {
  if (failed.has("Local Storage")) {
    warningCodes.add("local-storage-incompatible");
  }
  if (failed.has("IndexedDB")) warningCodes.add("indexeddb-incompatible");
  if (failed.has("File System")) {
    warningCodes.add("file-system-incompatible");
  }
  if (failed.has("Service Worker")) {
    warningCodes.add("service-worker-incompatible");
  }
  if (
    ["WebStorage", "Storage", "QuotaManager", "QuotaManager-journal"].some(
      (path) => failed.has(path as ChromeStoragePath),
    )
  ) {
    warningCodes.add("storage-metadata-incompatible");
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Chrome storage preflight timed out")),
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
