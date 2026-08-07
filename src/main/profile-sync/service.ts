import type { ImportedChromeCookie } from "../chrome-import/cookies.js";
import type { CookieWriteTarget } from "../chrome-import/cookie-writer.js";
import type {
  BrowserProfileRecord,
  BrowserProfileRegistry,
} from "../profile-registry.js";
import type { ProfileSyncCheckpointStore } from "./checkpoint-store.js";
import type {
  CookieSyncCheckpoint,
  CookieSyncDiff,
} from "./cookie-diff.js";
import {
  applyProfileCookieDiff,
  readProfileCookies,
} from "./cookie-target.js";
import type { ProfileCookieSourceProvider } from "./source-providers.js";

export type ProfileSyncPhase =
  | "idle"
  | "scanning"
  | "comparing"
  | "applying"
  | "complete"
  | "error";

export type ProfileSyncResult =
  | "disabled"
  | "unchanged"
  | "baselined"
  | "updated"
  | "conflict"
  | "error";

export type ProfileSyncStatus = {
  profileId: string;
  phase: ProfileSyncPhase;
  result?: ProfileSyncResult;
  completed: number;
  total: number;
  changed: number;
  conflicts: number;
  reason?: string;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  errorCode?: string;
};

export type ProfileSyncServiceOptions = {
  profiles: BrowserProfileRegistry;
  checkpoints: ProfileSyncCheckpointStore;
  sourceProviders: ProfileCookieSourceProvider[];
  createTarget: (profile: BrowserProfileRecord) => Promise<CookieWriteTarget>;
  diffCookies: (
    source: ImportedChromeCookie[],
    target: ImportedChromeCookie[],
    checkpoint?: CookieSyncCheckpoint,
    now?: number,
  ) => Promise<CookieSyncDiff>;
  onProgress?: (status: ProfileSyncStatus) => void;
  now?: () => number;
  startupDelayMs?: number;
  scanIntervalMs?: number;
};

export class ProfileSyncService {
  private readonly statuses = new Map<string, ProfileSyncStatus>();
  private readonly queues = new Map<string, Promise<ProfileSyncStatus>>();
  private startupTimer?: ReturnType<typeof setTimeout>;
  private scanTimer?: ReturnType<typeof setInterval>;
  private activeProfileId?: string;
  private closed = false;

  constructor(private readonly options: ProfileSyncServiceOptions) {}

  start() {
    if (this.closed || this.startupTimer || this.scanTimer) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.syncEnabledProfiles("startup");
    }, this.options.startupDelayMs ?? 900);
    this.startupTimer.unref?.();
    this.scanTimer = setInterval(() => {
      void this.syncEnabledProfiles("scheduled");
    }, this.options.scanIntervalMs ?? 5 * 60_000);
    this.scanTimer.unref?.();
  }

  async close() {
    this.closed = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.startupTimer = undefined;
    this.scanTimer = undefined;
    await Promise.race([
      Promise.allSettled(this.queues.values()),
      new Promise((resolve) => setTimeout(resolve, 1_500)),
    ]);
  }

  status(profileId: string) {
    return structuredClone(
      this.statuses.get(profileId) ?? idleStatus(profileId),
    );
  }

  async setEnabled(profileId: string, enabled: boolean) {
    await this.options.profiles.setLoginSyncEnabled(profileId, enabled);
    if (!enabled) {
      return this.publish({
        ...idleStatus(profileId),
        result: "disabled",
        lastAttemptAt: this.now(),
      });
    }
    return this.syncProfile(profileId, "enabled");
  }

  async syncProfile(profileId: string, reason = "manual") {
    const previous = this.queues.get(profileId) ?? Promise.resolve(
      this.status(profileId),
    );
    const operation = previous.then(
      () => this.performSync(profileId, reason),
      () => this.performSync(profileId, reason),
    );
    this.queues.set(profileId, operation);
    return operation.finally(() => {
      if (this.queues.get(profileId) === operation) {
        this.queues.delete(profileId);
      }
    });
  }

  async syncEnabledProfiles(reason = "scheduled") {
    const enabled = this.options.profiles
      .list()
      .filter((profile) => profile.source?.loginSyncEnabled);
    enabled.sort((left, right) => {
      if (left.id === this.activeProfileId) return -1;
      if (right.id === this.activeProfileId) return 1;
      return left.createdAt - right.createdAt;
    });
    const results: ProfileSyncStatus[] = [];
    for (const profile of enabled) {
      if (this.closed) break;
      results.push(await this.syncProfile(profile.id, reason));
    }
    return results;
  }

  notifyProfileActive(profileId: string) {
    this.activeProfileId = profileId;
    const profile = this.options.profiles.getOrThrow(profileId);
    if (!profile.source?.loginSyncEnabled || this.closed) return;
    const lastAttempt = this.statuses.get(profileId)?.lastAttemptAt ?? 0;
    if (this.now() - lastAttempt < 10_000) return;
    setTimeout(() => void this.syncProfile(profileId, "profile-active"), 0).unref?.();
  }

  async seedProfile(
    profileId: string,
    sourceCookies: ImportedChromeCookie[],
    sourceRevision?: string,
  ) {
    const profile = this.options.profiles.getOrThrow(profileId);
    const target = await this.options.createTarget(profile);
    try {
      const targetCookies = await readProfileCookies(target);
      const diff = await this.options.diffCookies(
        sourceCookies,
        targetCookies,
        undefined,
        this.now(),
      );
      await this.options.checkpoints.save({
        version: 1,
        profileId,
        sourceRevision,
        cookies: diff.checkpoint,
        storage: {},
        updatedAt: this.now(),
      });
    } finally {
      await target.dispose();
    }
  }

  async removeProfile(profileId: string) {
    this.statuses.delete(profileId);
    await this.options.checkpoints.remove(profileId);
  }

  private async performSync(profileId: string, reason: string) {
    const attemptAt = this.now();
    let profile: BrowserProfileRecord;
    try {
      profile = this.options.profiles.getOrThrow(profileId);
    } catch {
      return this.publish({
        ...idleStatus(profileId),
        phase: "error",
        result: "error",
        reason,
        lastAttemptAt: attemptAt,
        errorCode: "profile-sync-profile-missing",
      });
    }
    if (!profile.source?.loginSyncEnabled) {
      return this.publish({
        ...idleStatus(profileId),
        result: "disabled",
        reason,
        lastAttemptAt: attemptAt,
      });
    }

    try {
      this.publish({
        ...idleStatus(profileId),
        phase: "scanning",
        completed: 0,
        total: 4,
        reason,
        lastAttemptAt: attemptAt,
      });
      const checkpoint = await this.options.checkpoints.load(profileId);
      const provider = this.options.sourceProviders.find((candidate) =>
        candidate.supports(profile.source!),
      );
      if (!provider) throw new Error("profile-sync-source-unsupported");
      const source = await provider.snapshot(
        profile,
        checkpoint?.sourceRevision,
      );
      if (source.unchanged) {
        return this.publish({
          ...idleStatus(profileId),
          phase: "complete",
          result: "unchanged",
          completed: 4,
          total: 4,
          reason,
          lastAttemptAt: attemptAt,
          lastSuccessAt: this.now(),
        });
      }

      this.publish({
        ...idleStatus(profileId),
        phase: "comparing",
        completed: 1,
        total: 4,
        reason,
        lastAttemptAt: attemptAt,
      });
      const target = await this.options.createTarget(profile);
      try {
        const targetCookies = await readProfileCookies(target);
        const diff = await this.options.diffCookies(
          source.cookies,
          targetCookies,
          checkpoint?.cookies,
          this.now(),
        );
        const changed = diff.stats.set + diff.stats.removed;
        if (changed > 0) {
          this.publish({
            ...idleStatus(profileId),
            phase: "applying",
            completed: 2,
            total: 4,
            changed,
            conflicts: diff.stats.conflicts,
            reason,
            lastAttemptAt: attemptAt,
          });
          await applyProfileCookieDiff(target, diff);
        }
        await this.options.checkpoints.save({
          version: 1,
          profileId,
          sourceRevision: source.revision,
          cookies: diff.checkpoint,
          storage: checkpoint?.storage ?? {},
          updatedAt: this.now(),
        });
        const result: ProfileSyncResult = !checkpoint
          ? "baselined"
          : diff.stats.conflicts > 0
            ? "conflict"
            : changed > 0
              ? "updated"
              : "unchanged";
        return this.publish({
          ...idleStatus(profileId),
          phase: "complete",
          result,
          completed: 4,
          total: 4,
          changed,
          conflicts: diff.stats.conflicts,
          reason,
          lastAttemptAt: attemptAt,
          lastSuccessAt: this.now(),
        });
      } finally {
        await target.dispose();
      }
    } catch (error) {
      return this.publish({
        ...idleStatus(profileId),
        phase: "error",
        result: "error",
        completed: 4,
        total: 4,
        reason,
        lastAttemptAt: attemptAt,
        errorCode: syncErrorCode(error),
      });
    }
  }

  private publish(status: ProfileSyncStatus) {
    this.statuses.set(status.profileId, structuredClone(status));
    try {
      this.options.onProgress?.(structuredClone(status));
    } catch {
      // UI progress is observational and never controls synchronization.
    }
    return structuredClone(status);
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }
}

function idleStatus(profileId: string): ProfileSyncStatus {
  return {
    profileId,
    phase: "idle",
    completed: 0,
    total: 4,
    changed: 0,
    conflicts: 0,
  };
}

function syncErrorCode(error: unknown) {
  const code = String((error as any)?.code || "");
  if (/^[a-z0-9-]{3,80}$/.test(code)) return code;
  const message = error instanceof Error ? error.message : "";
  if (/^profile-sync-[a-z0-9-]{3,80}$/.test(message)) return message;
  if (message.includes("keychain")) return "profile-sync-keychain-unavailable";
  if (message.includes("cookie")) return "profile-sync-cookie-failed";
  return "profile-sync-failed";
}
