import { homedir } from "node:os";
import { join } from "node:path";
import { readChromeCookies } from "./chrome-import/cookies.js";
import { MacKeychainProvider } from "./chrome-import/keychain.js";
import type { BrowserProfileRegistry } from "./profile-registry.js";
import type { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";
import { ProfileSyncCheckpointStore } from "./profile-sync/checkpoint-store.js";
import { diffProfileCookies } from "./profile-sync/cookie-diff.js";
import { applyProfileCookieDiff, readProfileCookies } from "./profile-sync/cookie-target.js";

export type NativeCefProfileSyncOptions = {
  manager: NativeCefTaskSpaceManager;
  profiles: BrowserProfileRegistry;
  sourcePartitionsRoot: string;
  checkpointRoot: string;
  keychainHelper: string;
  intervalMs?: number;
};

/**
 * Native CEF Cookie sync adapter.
 *
 * It reuses the same hash/checkpoint conflict semantics as the Electron path,
 * but writes through a Space's CEF CDP target. File storage is never replaced
 * while a Space is running; the CEF user-data directory remains owned by CEF.
 */
export class NativeCefProfileSync {
  private readonly checkpoints: ProfileSyncCheckpointStore;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly queues = new Map<number, Promise<void>>();

  constructor(private readonly options: NativeCefProfileSyncOptions) {
    this.checkpoints = new ProfileSyncCheckpointStore(options.checkpointRoot);
  }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.syncRunningSpaces(), this.options.intervalMs ?? 5 * 60_000);
    this.timer.unref?.();
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled(this.queues.values());
  }

  async syncRunningSpaces() {
    for (const space of this.options.manager.listRunningSpaces()) {
      if (this.closed) break;
      const previous = this.queues.get(space.id) ?? Promise.resolve();
      const operation = previous.then(() => this.syncSpace(space.id), () => this.syncSpace(space.id));
      this.queues.set(space.id, operation);
      void operation.finally(() => {
        if (this.queues.get(space.id) === operation) this.queues.delete(space.id);
      });
    }
  }

  async syncSpace(spaceId: number) {
    const space = this.options.manager.getSpaceOrThrow(spaceId);
    if (space.profileMode !== "persistent") return;
    const profile = this.options.profiles.getOrThrow(space.profileId);
    if (!profile.source?.loginSyncEnabled) return;
    const sourceRoot = this.sourceRoot(profile);
    const cookiePath = await firstFile(join(sourceRoot, "Network", "Cookies"), join(sourceRoot, "Cookies"));
    if (!cookiePath) return;
    const source = await readChromeCookies(cookiePath, new MacKeychainProvider(this.options.keychainHelper));
    const target = await this.options.manager.createCookieWriteTarget(spaceId);
    try {
      const targetCookies = await readProfileCookies(target);
      const checkpointId = this.checkpointId(spaceId);
      const checkpoint = await this.checkpoints.load(checkpointId);
      const diff = diffProfileCookies(source.cookies, targetCookies, checkpoint?.cookies);
      if (diff.stats.set || diff.stats.removed) await applyProfileCookieDiff(target, diff);
      await this.checkpoints.save({
        version: 1,
        profileId: checkpointId,
        sourceRevision: undefined,
        cookies: diff.checkpoint,
        storage: checkpoint?.storage ?? {},
        updatedAt: Date.now(),
      });
    } finally {
      await target.dispose();
    }
  }

  async baselineSpace(spaceId: number) {
    const space = this.options.manager.getSpaceOrThrow(spaceId);
    if (space.profileMode !== "persistent") return;
    const profile = this.options.profiles.getOrThrow(space.profileId);
    if (!profile.source?.loginSyncEnabled) return;
    const sourceRoot = this.sourceRoot(profile);
    const cookiePath = await firstFile(join(sourceRoot, "Network", "Cookies"), join(sourceRoot, "Cookies"));
    if (!cookiePath) return;
    const source = await readChromeCookies(cookiePath, new MacKeychainProvider(this.options.keychainHelper));
    const target = await this.options.manager.createCookieWriteTarget(spaceId);
    try {
      const diff = diffProfileCookies(source.cookies, await readProfileCookies(target), undefined);
      await this.checkpoints.save({
        version: 1,
        profileId: this.checkpointId(spaceId),
        cookies: diff.checkpoint,
        storage: {},
        updatedAt: Date.now(),
      });
    } finally {
      await target.dispose();
    }
  }

  private checkpointId(spaceId: number) {
    return `space-${spaceId}`;
  }

  private sourceRoot(profile: ReturnType<BrowserProfileRegistry["getOrThrow"]>) {
    if (profile.source?.type === "chrome") {
      const chromeRoot = process.env.UFO_BROWSER_CHROME_USER_DATA ||
        join(homedir(), "Library", "Application Support", "Google", "Chrome");
      return join(chromeRoot, profile.source.profileDirName);
    }
    return join(this.options.sourcePartitionsRoot, profile.partitionId);
  }
}

async function firstFile(...paths: string[]) {
  for (const path of paths) {
    const { lstat } = await import("node:fs/promises");
    try {
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) return path;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}
