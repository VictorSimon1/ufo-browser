import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { AgentServer } from "./agent-server.js";
import { NativeCefBroker } from "./native-cef-broker.js";
import { NativeCefSnapshotService } from "./native-cef-snapshot.js";
import { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";
import { BrowserProfileRegistry } from "./profile-registry.js";
import { BrowserStateStore } from "./state-store.js";
import { SpaceLeaseRegistry } from "./space-lease.js";
import { NativeCefOverview } from "./native-cef-overview.js";
import { readChromeCookies } from "./chrome-import/cookies.js";
import { MacKeychainProvider } from "./chrome-import/keychain.js";
import { writeAndVerifyCookies } from "./chrome-import/cookie-writer.js";
import { NativeCefPresentationCoordinator } from "./native-cef-presentation.js";
import { NativeCefProfileSync } from "./native-cef-profile-sync.js";
import { NativeCefProfileService } from "./native-cef-profile-service.js";
import type { BrowserProfileRecord } from "./profile-registry.js";

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
  devtoolsSocketsRoot: join(userDataPath, "DevTools"),
  onRuntimeReady: async (spaceId) => profileSync?.baselineSpace(spaceId),
  seedCookies: async (profileId, target) => {
    const profile = profiles.getOrThrow(profileId);
    const sourceRoot = profileSourceRoot(profile, sourcePartitionsRoot);
    const cookiePath = await firstFile(join(sourceRoot, "Network", "Cookies"), join(sourceRoot, "Cookies"));
    if (!cookiePath) return;
    const result = await readChromeCookies(cookiePath, new MacKeychainProvider(keychainHelper));
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
  startRuntime: process.env.UFO_BROWSER_NATIVE_OVERVIEW_MODE !== "external",
  infoFile: process.env.UFO_BROWSER_OVERVIEW_INFO_FILE,
  controlSocket: overviewControlSocket,
  profileService,
  profiles,
  rendererRoot: process.env.UFO_BROWSER_NATIVE_RENDERER_ROOT || join(process.cwd(), "dist/renderer"),
});
await overview.start();
const presentation = new NativeCefPresentationCoordinator(manager, overview);
overview.setPresentationController(presentation);
manager.setPresentationHooks({
  onSpaceClosed: (spaceId) => presentation.onSpaceClosed(spaceId),
  onSpaceStateChanged: (spaceId) => presentation.onSpaceStateChanged(spaceId),
});
const leases = new SpaceLeaseRegistry();
const broker = new NativeCefBroker(manager);
const snapshot = new NativeCefSnapshotService(manager);
const server = new AgentServer(socketPath, manager, leases, snapshot, broker, "0.1.7-cef");
await server.listen();
console.error(`[UFO Native CEF] Agent socket: ${socketPath}`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close().catch(() => undefined);
  await profileSync?.close().catch(() => undefined);
  await manager.shutdown().catch(() => undefined);
  await overview.stop().catch(() => undefined);
  await manager.flushState().catch(() => undefined);
}
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
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
