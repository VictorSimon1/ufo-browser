import { homedir } from "node:os";
import { join } from "node:path";
import { readChromeCookies } from "./chrome-import/cookies.js";
import { MacKeychainProvider } from "./chrome-import/keychain.js";
import { detectChromeRunning } from "./chrome-import/discovery.js";
import { CHROME_STORAGE_PATHS } from "./chrome-import/storage-preflight.js";
import type { BrowserProfileRegistry } from "./profile-registry.js";
import type { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";
import { ProfileSyncCheckpointStore } from "./profile-sync/checkpoint-store.js";
import { diffProfileCookies } from "./profile-sync/cookie-diff.js";
import { applyProfileCookieDiff, readProfileCookies } from "./profile-sync/cookie-target.js";
import { createStorageRevisionWorker } from "./profile-sync/storage-revision-worker-reader.js";
import { replaceProfileStorageDataset } from "./profile-sync/storage-copy.js";

export type NativeCefProfileSyncOptions = {
  manager: NativeCefTaskSpaceManager;
  profiles: BrowserProfileRegistry;
  sourcePartitionsRoot: string;
  checkpointRoot: string;
  keychainHelper: string;
  storageRevisionWorker?: string;
  storageWorkRoot?: string;
  chromeUserDataRoot?: string;
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
      const existing = await this.checkpoints.load(this.checkpointId(spaceId));
      await this.checkpoints.save({
        version: 1,
        profileId: this.checkpointId(spaceId),
        cookies: diff.checkpoint,
        storage: existing?.storage ?? {},
        updatedAt: Date.now(),
      });
    } finally {
      await target.dispose();
    }
  }

  /**
   * Sync file-backed login state while a CEF Space is still cold. Chromium's
   * LevelDB/SQLite datasets must never be replaced underneath a live runtime.
   */
  async syncStorageBeforeRuntime(spaceId: number, targetRoot: string) {
    if (this.closed) return;
    const space = this.options.manager.getSpaceOrThrow(spaceId);
    if (space.profileMode !== "persistent") return;
    const profile = this.options.profiles.getOrThrow(space.profileId);
    if (!profile.source?.loginSyncEnabled || !this.options.storageRevisionWorker) return;
    if (profile.source.type === "chrome") {
      const chromeRoot = this.options.chromeUserDataRoot ||
        process.env.UFO_BROWSER_CHROME_USER_DATA ||
        join(homedir(), "Library", "Application Support", "Google", "Chrome");
      if ((await detectChromeRunning(chromeRoot)).running) return;
    }
    const sourceRoot = this.sourceRoot(profile);
    const scan = createStorageRevisionWorker(this.options.storageRevisionWorker);
    const checkpointId = this.checkpointId(spaceId);
    const checkpoint = await this.checkpoints.load(checkpointId);
    const revisions = await scan(sourceRoot, targetRoot, [...CHROME_STORAGE_PATHS]);
    const nextStorage = { ...(checkpoint?.storage ?? {}) };
    const apply: Array<{ dataset: string; sourcePresent: boolean }> = [];
    const now = Date.now();
    if (!checkpoint?.storage || Object.keys(checkpoint.storage).length === 0) {
      for (const dataset of CHROME_STORAGE_PATHS) {
        const current = revisions[dataset] ?? { sourceRevision: null, targetRevision: null };
        nextStorage[dataset] = { ...current, updatedAt: now };
      }
      await this.checkpoints.save({
        version: 1,
        profileId: checkpointId,
        cookies: checkpoint?.cookies ?? {},
        storage: nextStorage,
        updatedAt: now,
      });
      return;
    }
    let conflicts = 0;
    for (const dataset of CHROME_STORAGE_PATHS) {
      const current = revisions[dataset] ?? { sourceRevision: null, targetRevision: null };
      const before = checkpoint.storage[dataset];
      if (!before) {
        nextStorage[dataset] = { ...current, updatedAt: now };
      } else if (current.sourceRevision === before.sourceRevision) {
        nextStorage[dataset] = before;
      } else if (current.targetRevision !== before.targetRevision) {
        conflicts++;
        nextStorage[dataset] = { ...current, updatedAt: now };
      } else {
        apply.push({ dataset, sourcePresent: current.sourceRevision !== null });
      }
    }
    for (const change of apply) {
      await replaceProfileStorageDataset({
        sourceRoot,
        targetRoot,
        workRoot: join(this.options.storageWorkRoot || join(this.options.checkpointRoot, "storage-work"), checkpointId),
        dataset: change.dataset,
        sourcePresent: change.sourcePresent,
      });
    }
    if (apply.length > 0) {
      const after = await scan(sourceRoot, targetRoot, apply.map((change) => change.dataset));
      for (const change of apply) {
        const current = after[change.dataset];
        const beforeApply = revisions[change.dataset];
        nextStorage[change.dataset] = {
          sourceRevision: beforeApply?.sourceRevision ?? null,
          targetRevision: current?.targetRevision ?? null,
          updatedAt: now,
        };
      }
    }
    await this.checkpoints.save({
      version: 1,
      profileId: checkpointId,
      sourceRevision: checkpoint?.sourceRevision,
      cookies: checkpoint?.cookies ?? {},
      storage: nextStorage,
      updatedAt: now,
    });
    void conflicts;
  }

  private checkpointId(spaceId: number) {
    return `space-${spaceId}`;
  }

  private sourceRoot(profile: ReturnType<BrowserProfileRegistry["getOrThrow"]>) {
    if (profile.source?.type === "chrome") {
      const chromeRoot = this.options.chromeUserDataRoot ||
        process.env.UFO_BROWSER_CHROME_USER_DATA ||
        join(homedir(), "Library", "Application Support", "Google", "Chrome");
      return join(chromeRoot, profile.source.profileDirName);
    }
    if (profile.source?.type === "ufo") {
      const sourceProfile = this.options.profiles.getOrThrow(profile.source.profileId);
      return join(this.options.sourcePartitionsRoot, sourceProfile.partitionId);
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
