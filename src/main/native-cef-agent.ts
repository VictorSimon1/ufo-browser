import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AgentServer } from "./agent-server.js";
import { NativeCefBroker } from "./native-cef-broker.js";
import { NativeCefSnapshotService } from "./native-cef-snapshot.js";
import { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";
import { BrowserProfileRegistry } from "./profile-registry.js";
import { BrowserStateStore } from "./state-store.js";
import { SpaceLeaseRegistry } from "./space-lease.js";

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
const stateStore = new BrowserStateStore(join(userDataPath, "browser-state.json"));
const profiles = new BrowserProfileRegistry(join(userDataPath, "profiles.json"));
await profiles.initialize();
const manager = new NativeCefTaskSpaceManager({
  store: stateStore,
  profiles,
  partitionsRoot,
  executable: process.env.UFO_CEF_HOST,
  portBase: Number(process.env.UFO_CEF_PORT_BASE || 9420),
});
await manager.initialize();
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
  await manager.flushState().catch(() => undefined);
}
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("exit", () => { void manager.shutdown(); });

