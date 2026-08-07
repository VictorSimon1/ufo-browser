import { join } from "node:path";
import { CHROME_STORAGE_PATHS } from "../chrome-import/storage-preflight.js";
import type { BrowserProfileRegistry } from "../profile-registry.js";
import type { ProfileSyncCheckpointStore } from "./checkpoint-store.js";
import { replaceProfileStorageDataset } from "./storage-copy.js";
import type { StorageDatasetRevisions } from "./storage-revision-worker-reader.js";
import type { ProfileCookieSourceProvider } from "./source-providers.js";

export type ProfileStorageSyncStatus = {
  profileId: string;
  phase: "scanning" | "applying" | "complete" | "error";
  result: "unchanged" | "baselined" | "updated" | "conflict" | "skipped" | "error";
  completed: number;
  total: number;
  changed: number;
  conflicts: number;
  detailCode: "storage";
  errorCode?: string;
};

export class ProfileStorageSyncService {
  private readonly prepared = new Set<string>();
  private readonly queues = new Map<string, Promise<ProfileStorageSyncStatus>>();

  constructor(
    private readonly options: {
      profiles: BrowserProfileRegistry;
      checkpoints: ProfileSyncCheckpointStore;
      sourceProviders: ProfileCookieSourceProvider[];
      partitionsRoot: string;
      workRoot: string;
      scanRevisions: (
        sourceRoot: string,
        targetRoot: string,
        datasets: string[],
      ) => Promise<StorageDatasetRevisions>;
      flushTarget?: (profileId: string) => Promise<unknown>;
      onProgress?: (status: ProfileStorageSyncStatus) => void;
      now?: () => number;
    },
  ) {}

  prepareProfile(profileId: string) {
    return this.enqueue(profileId, false, false);
  }

  seedProfile(profileId: string) {
    return this.enqueue(profileId, true, false);
  }

  rebaselineProfile(profileId: string) {
    this.prepared.delete(profileId);
    return this.enqueue(profileId, true, true);
  }

  private enqueue(
    profileId: string,
    baselineOnly: boolean,
    replaceBaseline: boolean,
  ) {
    if (this.prepared.has(profileId) && !replaceBaseline) {
      return Promise.resolve(completeStatus(profileId, "unchanged"));
    }
    const previous = this.queues.get(profileId) ?? Promise.resolve(
      completeStatus(profileId, "unchanged"),
    );
    const run = () =>
      this.prepared.has(profileId) && !replaceBaseline
        ? Promise.resolve(completeStatus(profileId, "unchanged"))
        : this.perform(profileId, baselineOnly, replaceBaseline);
    const operation = previous
      .then(run, run)
      .then((status) => {
        // A completed gate means Chromium is now allowed to create the target
        // Session. Even skipped/error scans must not retry file replacement
        // later in the same run after that Session may already be alive.
        this.prepared.add(profileId);
        return status;
      });
    this.queues.set(profileId, operation);
    return operation.finally(() => {
      if (this.queues.get(profileId) === operation) this.queues.delete(profileId);
    });
  }

  forgetProfile(profileId: string) {
    this.prepared.delete(profileId);
  }

  private async perform(
    profileId: string,
    baselineOnly = false,
    replaceBaseline = false,
  ): Promise<ProfileStorageSyncStatus> {
    const profile = this.options.profiles.getOrThrow(profileId);
    if (!profile.source || (!profile.source.loginSyncEnabled && !baselineOnly)) {
      return completeStatus(profileId, "skipped");
    }
    try {
      this.publish({
        ...completeStatus(profileId, "unchanged"),
        phase: "scanning",
        completed: 0,
      });
      const provider = this.options.sourceProviders.find((candidate) =>
        candidate.supports(profile.source!),
      );
      const source = await provider?.storageSource?.(profile);
      if (!source || !source.quiescent) {
        return this.publish(completeStatus(profileId, "skipped"));
      }
      if (baselineOnly) {
        await this.options.flushTarget?.(profileId);
        // Electron's flushStorageData() schedules Chromium backend work but
        // does not return a Promise. Give SQLite/LevelDB journals one bounded
        // turn to settle before taking the non-destructive baseline.
        await delay(120);
      }
      const targetRoot = join(this.options.partitionsRoot, profile.partitionId);
      const revisions = await this.options.scanRevisions(
        source.root,
        targetRoot,
        [...CHROME_STORAGE_PATHS],
      );
      const checkpoint = await this.options.checkpoints.load(profileId);
      const nextStorage = { ...(checkpoint?.storage ?? {}) };
      const apply: Array<{ dataset: string; sourcePresent: boolean }> = [];
      let conflicts = 0;
      let baselined = 0;
      const now = (this.options.now ?? Date.now)();
      for (const dataset of CHROME_STORAGE_PATHS) {
        const current = revisions[dataset] ?? {
          sourceRevision: null,
          targetRevision: null,
        };
        const before = checkpoint?.storage?.[dataset];
        if (!before || replaceBaseline) {
          baselined++;
          nextStorage[dataset] = { ...current, updatedAt: now };
          continue;
        }
        if (baselineOnly) {
          nextStorage[dataset] = before;
          continue;
        }
        if (current.sourceRevision === before.sourceRevision) {
          nextStorage[dataset] = before;
          continue;
        }
        if (current.targetRevision !== before.targetRevision) {
          conflicts++;
          nextStorage[dataset] = { ...current, updatedAt: now };
          continue;
        }
        apply.push({
          dataset,
          sourcePresent: current.sourceRevision !== null,
        });
      }

      if (apply.length > 0) {
        this.publish({
          ...completeStatus(profileId, "updated"),
          phase: "applying",
          completed: 2,
          changed: apply.length,
          conflicts,
        });
        for (const change of apply) {
          await replaceProfileStorageDataset({
            sourceRoot: source.root,
            targetRoot,
            workRoot: join(this.options.workRoot, profileId),
            dataset: change.dataset,
            sourcePresent: change.sourcePresent,
          });
        }
        const after = await this.options.scanRevisions(
          source.root,
          targetRoot,
          apply.map((change) => change.dataset),
        );
        for (const change of apply) {
          const current = after[change.dataset];
          const beforeApply = revisions[change.dataset];
          nextStorage[change.dataset] = {
            // Keep the revision that authorized this copy. If the source
            // changes during copying, the next App launch sees a new source
            // revision instead of falsely checkpointing data we did not copy.
            sourceRevision: beforeApply?.sourceRevision ?? null,
            targetRevision: current?.targetRevision ?? null,
            updatedAt: now,
          };
        }
      }

      await this.options.checkpoints.save({
        version: 1,
        profileId,
        sourceRevision: checkpoint?.sourceRevision,
        cookies: checkpoint?.cookies ?? {},
        storage: nextStorage,
        updatedAt: now,
      });
      return this.publish({
        ...completeStatus(
          profileId,
          !checkpoint || baselined > 0
            ? "baselined"
            : conflicts > 0
              ? "conflict"
              : apply.length > 0
                ? "updated"
                : "unchanged",
        ),
        changed: apply.length,
        conflicts,
        completed: 4,
      });
    } catch (error) {
      return this.publish({
        ...completeStatus(profileId, "error"),
        phase: "error",
        errorCode: storageErrorCode(error),
      });
    }
  }

  private publish(status: ProfileStorageSyncStatus) {
    try {
      this.options.onProgress?.(structuredClone(status));
    } catch {
      // Progress is observational.
    }
    return structuredClone(status);
  }
}

function completeStatus(
  profileId: string,
  result: ProfileStorageSyncStatus["result"],
): ProfileStorageSyncStatus {
  return {
    profileId,
    phase: result === "error" ? "error" : "complete",
    result,
    completed: 4,
    total: 4,
    changed: 0,
    conflicts: 0,
    detailCode: "storage",
  };
}

function storageErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("revision")) return "profile-storage-revision-failed";
  if (message.includes("dataset")) return "profile-storage-dataset-failed";
  return "profile-storage-sync-failed";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
