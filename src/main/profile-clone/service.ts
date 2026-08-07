import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ImportedChromeCookie } from "../chrome-import/cookies.js";
import type { CookieWriteTarget } from "../chrome-import/cookie-writer.js";
import { writeAndVerifyCookies } from "../chrome-import/cookie-writer.js";
import type { ProfileAvatarStore } from "../profile-avatar-store.js";
import type {
  BrowserProfileRecord,
  BrowserProfileRegistry,
} from "../profile-registry.js";
import { readProfileCookies } from "../profile-sync/cookie-target.js";
import type { ProfileSyncService } from "../profile-sync/service.js";
import { copyProfileLoginStorage } from "./files.js";

export type CloneUfoProfileOptions = {
  sourceProfileId: string;
  name?: string;
  makeDefault?: boolean;
  loginSyncEnabled?: boolean;
};

export class ProfileCloneService {
  constructor(
    private readonly options: {
      profiles: BrowserProfileRegistry;
      partitionsRoot: string;
      avatars: ProfileAvatarStore;
      sync: ProfileSyncService;
      createTarget: (profile: BrowserProfileRecord) => Promise<CookieWriteTarget>;
      now?: () => number;
    },
  ) {}

  async cloneUfoProfile(input: CloneUfoProfileOptions) {
    const source = this.options.profiles.getOrThrow(input.sourceProfileId);
    const suffix = randomUUID().replace(/-/g, "").slice(0, 32);
    const profileId = `ufo-${suffix}`;
    const partitionId = `x-browser-profile-${profileId}`;
    const sourcePartition = join(
      this.options.partitionsRoot,
      source.partitionId,
    );
    const targetPartition = join(this.options.partitionsRoot, partitionId);
    const stagingPartition = join(
      this.options.partitionsRoot,
      `.clone-${suffix}`,
    );
    const now = (this.options.now ?? Date.now)();
    const profile: BrowserProfileRecord = {
      id: profileId,
      partitionId,
      name: normalizeCloneName(input.name, source.name),
      kind: "imported",
      source: {
        type: "ufo",
        browser: "ufo-browser",
        profileId: source.id,
        displayName: source.name,
        importedAt: now,
        lastImportStatus: "success",
        loginSyncEnabled: input.loginSyncEnabled === true,
      },
      createdAt: now,
      updatedAt: now,
    };
    let published = false;
    try {
      await mkdir(this.options.partitionsRoot, {
        recursive: true,
        mode: 0o700,
      });
      const sourceTarget = await this.options.createTarget(source);
      let sourceCookies: ImportedChromeCookie[];
      try {
        sourceCookies = await readProfileCookies(sourceTarget);
        await sourceTarget.flush();
      } finally {
        await sourceTarget.dispose();
      }
      await copyProfileLoginStorage(sourcePartition, stagingPartition);
      await rename(stagingPartition, targetPartition);
      const target = await this.options.createTarget(profile);
      try {
        if (sourceCookies.length > 0) {
          await writeAndVerifyCookies(target, sourceCookies);
        } else {
          await target.flush();
        }
      } finally {
        await target.dispose();
      }
      await this.options.profiles.add(profile, input.makeDefault === true);
      published = true;
      await this.options.avatars.clone(source.id, profile.id).catch(() => false);
      await this.options.sync.seedProfile(profile.id, sourceCookies).catch(
        () => undefined,
      );
      return profile;
    } finally {
      await rm(stagingPartition, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (!published) {
        await rm(targetPartition, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }
}

function normalizeCloneName(value: string | undefined, sourceName: string) {
  const name = String(value || "").trim() || `${sourceName} 副本`;
  return name.slice(0, 160);
}
