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

const userDataPath = resolve(
  process.env.UFO_BROWSER_NATIVE_USER_DATA ||
    process.env.X_BROWSER_NATIVE_USER_DATA ||
    join(homedir(), "Library/Application Support/UFO-Browser-Native"),
);
const socketPath = resolve(
  process.env.UFO_BROWSER_SOCKET ||
    process.env.X_BROWSER_SOCKET ||
    join(userDataPath, "ufo-browser.sock"),
);
const partitionsRoot = join(userDataPath, "Spaces");
const sourcePartitionsRoot = resolve(
  process.env.UFO_BROWSER_SOURCE_PARTITIONS ||
    join(homedir(), "Library/Application Support/UFO-Browser", "Partitions"),
);
const stateStore = new BrowserStateStore(join(userDataPath, "browser-state.json"));
const profiles = new BrowserProfileRegistry(join(userDataPath, "profiles.json"));
await profiles.initialize();
const keychainHelper = process.env.UFO_BROWSER_KEYCHAIN_HELPER ||
  process.env.UFO_BROWSER_NATIVE_KEYCHAIN_HELPER ||
  join(homedir(), "Library/Application Support/UFO-Browser", "ufo-keychain-helper");
const manager = new NativeCefTaskSpaceManager({
  store: stateStore,
  profiles,
  partitionsRoot,
  executable: process.env.UFO_CEF_HOST,
  portBase: Number(process.env.UFO_CEF_PORT_BASE || 9420),
  useMockKeychain: process.env.UFO_CEF_USE_MOCK_KEYCHAIN === "1",
  sourcePartitionsRoot,
  seedCookies: async (profileId, target) => {
    const profile = profiles.getOrThrow(profileId);
    const sourceRoot = join(sourcePartitionsRoot, profile.partitionId);
    const cookiePath = await firstFile(join(sourceRoot, "Network", "Cookies"), join(sourceRoot, "Cookies"));
    if (!cookiePath) return;
    const result = await readChromeCookies(cookiePath, new MacKeychainProvider(keychainHelper));
    await writeAndVerifyCookies(target, result.cookies);
  },
});
await manager.initialize();
const overview = new NativeCefOverview({
  manager,
  executable: process.env.UFO_CEF_HOST,
  userDataDir: join(userDataPath, "Overview"),
  port: Number(process.env.UFO_CEF_OVERVIEW_HTTP_PORT || 0),
  devtoolsPort: Number(process.env.UFO_CEF_OVERVIEW_PORT || 0),
  useMockKeychain: process.env.UFO_CEF_USE_MOCK_KEYCHAIN === "1",
  startRuntime: process.env.UFO_BROWSER_NATIVE_OVERVIEW_MODE !== "external",
  infoFile: process.env.UFO_BROWSER_OVERVIEW_INFO_FILE,
});
await overview.start();
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
