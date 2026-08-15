import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lstat, mkdir, rm } from "node:fs/promises";
import { AgentServer } from "./agent-server.js";
import { NativeCefBroker } from "./native-cef-broker.js";
import { NativeCefSnapshotService } from "./native-cef-snapshot.js";
import { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";
import { BrowserProfileRegistry } from "./profile-registry.js";
import { BrowserStateStore } from "./state-store.js";
import { SpaceLeaseRegistry } from "./space-lease.js";
import { NativeCefOverview } from "./native-cef-overview.js";
import { readChromeCookies } from "./chrome-import/cookies.js";
import { writeAndVerifyCookies } from "./chrome-import/cookie-writer.js";
import { NativeCefPresentationCoordinator } from "./native-cef-presentation.js";
import { NativeCefProfileSync } from "./native-cef-profile-sync.js";
import { NativeCefProfileService } from "./native-cef-profile-service.js";
import type { BrowserProfileRecord } from "./profile-registry.js";
import { createNativeKeychain } from "./native-cef-keychain.js";
import { NativeCefRuntime } from "./native-cef-runtime.js";

// Native CEF is the production browser shell, so it shares the existing UFO
// Profile registry, imported partitions, and default Agent socket. Tests and
// side-by-side development can override this root with an environment var.
const userDataPath = resolve(
  process.env.UFO_BROWSER_NATIVE_USER_DATA ||
    process.env.X_BROWSER_NATIVE_USER_DATA ||
    join(homedir(), "Library/Application Support/UFO-Browser"),
);
const socketPath = resolve(
  process.env.UFO_BROWSER_SOCKET ||
    process.env.X_BROWSER_SOCKET ||
    join(userDataPath, "ufo-browser.sock"),
);
const partitionsRoot = join(userDataPath, "Native Spaces");
const controlSocketsRoot = resolve(
  process.env.UFO_BROWSER_CONTROL_SOCKETS ||
    join(process.env.TMPDIR || "/tmp", `ufo-browser-${process.pid}`),
);
const overviewControlSocket = resolve(
  process.env.UFO_BROWSER_OVERVIEW_CONTROL_SOCKET ||
  join(controlSocketsRoot, "overview.sock"),
);
const sharedHostEnabled = process.env.UFO_BROWSER_NATIVE_SHARED_HOST !== "0";
const attachedHostEnabled = process.env.UFO_BROWSER_NATIVE_ATTACHED_HOST === "1";
const attachedHostPid = Number(process.env.UFO_BROWSER_NATIVE_HOST_PID || 0);
const sharedHostDevtoolsSocket = resolve(
  process.env.UFO_BROWSER_SHARED_HOST_DEVTOOLS_SOCKET ||
    join(
      process.env.UFO_BROWSER_DEVTOOLS_SOCKETS_ROOT ||
        join(process.env.TMPDIR || "/tmp", `ufo-browser-devtools-${process.pid}`),
      "shared-host.sock",
    ),
);
const presentationSocket = resolve(
  process.env.UFO_BROWSER_PRESENTATION_SOCKET ||
  join(controlSocketsRoot, "presentation.sock"),
);
const sourcePartitionsRoot = resolve(
  process.env.UFO_BROWSER_SOURCE_PARTITIONS || join(userDataPath, "Partitions"),
);
const stateStore = new BrowserStateStore(
  process.env.UFO_BROWSER_NATIVE_STATE_PATH || join(userDataPath, "browser-state.json"),
);
const profiles = new BrowserProfileRegistry(
  process.env.UFO_BROWSER_NATIVE_PROFILES_PATH || join(userDataPath, "profiles.json"),
);
await profiles.initialize();
let profileSync: NativeCefProfileSync | undefined;
const keychainHelper = process.env.UFO_BROWSER_KEYCHAIN_HELPER ||
  process.env.UFO_BROWSER_NATIVE_KEYCHAIN_HELPER ||
  join(homedir(), "Library/Application Support/UFO-Browser", "ufo-keychain-helper");
const manager = new NativeCefTaskSpaceManager({
  store: stateStore,
  profiles,
  partitionsRoot,
  executable: process.env.UFO_CEF_HOST,
  portBase: process.env.UFO_CEF_PORT_BASE
    ? Number(process.env.UFO_CEF_PORT_BASE)
    : undefined,
  useMockKeychain: process.env.UFO_CEF_USE_MOCK_KEYCHAIN === "1",
  sourcePartitionsRoot,
  controlSocketsRoot,
  presentationSocket,
  nativeChromeProductShell:
    // The packaged Native product now uses Chromium's own Chrome Runtime UI
    // by default. Keep an explicit opt-out for diagnostics and migration
    // comparisons; no environment variable should silently fall back to the
    // former application-owned CefBrowserView toolbar.
    process.env.UFO_BROWSER_NATIVE_CHROME_PRODUCT_SHELL !== "0",
  chromeUserDataRoot: userDataPath,
  // macOS sockaddr_un paths are limited to roughly 104 bytes. Keep transient
  // per-Space sockets under a short TMPDIR root; browser data remains under
  // the user-data directory and is not moved or exposed by this change.
  devtoolsSocketsRoot: resolve(
    process.env.UFO_BROWSER_DEVTOOLS_SOCKETS_ROOT ||
      join(process.env.TMPDIR || "/tmp", `ufo-browser-devtools-${process.pid}`),
  ),
  onRuntimeReady: async (spaceId) => profileSync?.baselineSpace(spaceId),
  seedCookies: async (profileId, target) => {
    const profile = profiles.getOrThrow(profileId);
    const sourceRoot = profileSourceRoot(profile, sourcePartitionsRoot);
    const cookiePath = await firstFile(join(sourceRoot, "Network", "Cookies"), join(sourceRoot, "Cookies"));
    if (!cookiePath) return;
    const result = await readChromeCookies(
      cookiePath,
      createNativeKeychain(keychainHelper),
    );
    await writeAndVerifyCookies(target, result.cookies);
  },
});
await manager.initialize();
const profileService = new NativeCefProfileService({
  userDataPath,
  partitionsRoot,
  sourcePartitionsRoot,
  profiles,
  manager,
  keychainHelper,
  storageWorker: process.env.UFO_BROWSER_NATIVE_STORAGE_REVISION_WORKER ||
    join(process.cwd(), "dist/main/profile-sync-storage-revision-worker.js"),
  chromeUserDataPath: process.env.UFO_BROWSER_CHROME_USER_DATA,
  useMockKeychain: process.env.UFO_CEF_USE_MOCK_KEYCHAIN === "1",
});
profileSync = new NativeCefProfileSync({
  manager,
  profiles,
  sourcePartitionsRoot,
  checkpointRoot: join(userDataPath, "Profile Sync", "checkpoints"),
  keychainHelper,
  useMockKeychain: process.env.UFO_CEF_USE_MOCK_KEYCHAIN === "1",
  storageRevisionWorker: process.env.UFO_BROWSER_NATIVE_STORAGE_REVISION_WORKER ||
    join(process.cwd(), "dist/main/profile-sync-storage-revision-worker.js"),
  storageWorkRoot: join(userDataPath, "Profile Sync", "storage-work"),
});
manager.setBeforeRuntimeStartHook(async (spaceId, _profileId, dataDir) =>
  profileSync?.syncStorageBeforeRuntime(spaceId, dataDir),
);
manager.setRuntimeReadyHook(async (spaceId) => profileSync?.baselineSpace(spaceId));
profileSync.start();
const overview = new NativeCefOverview({
  manager,
  executable: process.env.UFO_CEF_HOST,
  userDataDir: join(userDataPath, "Overview"),
  port: Number(process.env.UFO_CEF_OVERVIEW_HTTP_PORT || 0),
  devtoolsPort: Number(process.env.UFO_CEF_OVERVIEW_PORT || 0),
  useMockKeychain: process.env.UFO_CEF_USE_MOCK_KEYCHAIN === "1",
  startRuntime: !sharedHostEnabled &&
    process.env.UFO_BROWSER_NATIVE_OVERVIEW_MODE !== "external",
  infoFile: process.env.UFO_BROWSER_OVERVIEW_INFO_FILE,
  controlSocket: overviewControlSocket,
  profileService,
  profiles,
  rendererRoot: process.env.UFO_BROWSER_NATIVE_RENDERER_ROOT || join(process.cwd(), "dist/renderer"),
});
const overviewInfo = await overview.start();
if (sharedHostEnabled) {
  if (!overviewInfo?.url) throw new Error("Native Overview URL is unavailable");
  await mkdir(dirname(overviewControlSocket), { recursive: true, mode: 0o700 });
  await mkdir(dirname(sharedHostDevtoolsSocket), { recursive: true, mode: 0o700 });
  const sharedHost = new NativeCefRuntime({
    executable: process.env.UFO_CEF_HOST,
    url: overviewInfo.url,
    overview: true,
    chromeProfileDirectory: "Default",
    userDataDir: userDataPath,
    controlSocket: overviewControlSocket,
    presentationSocket,
    devtoolsSocket: sharedHostDevtoolsSocket,
    useMockKeychain: process.env.UFO_CEF_USE_MOCK_KEYCHAIN === "1",
  });
  if (attachedHostEnabled) {
    await sharedHost.attach();
    manager.setSharedHost(sharedHost, false);
  } else {
    await sharedHost.start();
    manager.setSharedHost(sharedHost, true);
  }
}
const leases = new SpaceLeaseRegistry();
const broker = new NativeCefBroker(manager);
const snapshot = new NativeCefSnapshotService(manager);
const server = new AgentServer(socketPath, manager, leases, snapshot, broker, "0.1.7-cef");
const presentation = new NativeCefPresentationCoordinator(manager, overview, presentationSocket);
presentation.setAgentControl({ revokeSpace: (spaceId) => server.revokeSpace(spaceId) });
await presentation.start();
overview.setPresentationController(presentation);
manager.setPresentationHooks({
  onSpaceClosed: (spaceId) => presentation.onSpaceClosed(spaceId),
  onSpaceStateChanged: (spaceId) => presentation.onSpaceStateChanged(spaceId),
});
await server.listen();
console.error(`[UFO Native CEF] Agent socket: ${socketPath}`);

let shuttingDown = false;
const attachedHostMonitor = attachedHostEnabled && Number.isInteger(attachedHostPid) && attachedHostPid > 1
  ? setInterval(() => {
      try {
        process.kill(attachedHostPid, 0);
      } catch {
        process.exit(0);
      }
    }, 1_000)
  : undefined;
attachedHostMonitor?.unref();
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (attachedHostMonitor) clearInterval(attachedHostMonitor);
  await server.close().catch(() => undefined);
  await profileSync?.close().catch(() => undefined);
  await manager.shutdown().catch(() => undefined);
  await presentation.stop().catch(() => undefined);
  await overview.stop().catch(() => undefined);
  await manager.flushState().catch(() => undefined);
  await rm(resolve(
    process.env.UFO_BROWSER_DEVTOOLS_SOCKETS_ROOT ||
      join(process.env.TMPDIR || "/tmp", `ufo-browser-devtools-${process.pid}`),
  ), { recursive: true, force: true }).catch(() => undefined);
}
process.once("SIGTERM", () => {
  if (attachedHostEnabled) process.exit(0);
  else void shutdown().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  if (attachedHostEnabled) process.exit(0);
  else void shutdown().finally(() => process.exit(0));
});
process.once("exit", () => { void manager.shutdown(); });

async function firstFile(...paths: string[]) {
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) return path;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

function profileSourceRoot(profile: BrowserProfileRecord, fallbackRoot: string) {
  if (profile.source?.type === "chrome") {
    const chromeRoot = process.env.UFO_BROWSER_CHROME_USER_DATA ||
      join(homedir(), "Library", "Application Support", "Google", "Chrome");
    return join(chromeRoot, profile.source.profileDirName);
  }
  if (profile.source?.type === "ufo") {
    const sourceProfile = profiles.getOrThrow(profile.source.profileId);
    return join(fallbackRoot, sourceProfile.partitionId);
  }
  return join(fallbackRoot, profile.partitionId);
}
