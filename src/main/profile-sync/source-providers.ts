import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ImportedChromeCookie } from "../chrome-import/cookies.js";
import type { ChromeCookieReadResult } from "../chrome-import/cookies.js";
import type {
  BrowserLoginSourceAdapter,
  DiscoveredChromeProfile,
} from "../chrome-import/discovery.js";
import type { CookieWriteTarget } from "../chrome-import/cookie-writer.js";
import type {
  BrowserProfileRecord,
  BrowserProfileSource,
} from "../profile-registry.js";
import { readProfileCookies } from "./cookie-target.js";

export type ProfileCookieSourceSnapshot =
  | { unchanged: true; revision: string }
  | {
      unchanged: false;
      revision?: string;
      cookies: ImportedChromeCookie[];
    };

export interface ProfileCookieSourceProvider {
  supports(source: BrowserProfileSource): boolean;
  snapshot(
    profile: BrowserProfileRecord,
    previousRevision?: string,
  ): Promise<ProfileCookieSourceSnapshot>;
}

export class ChromeProfileCookieSourceProvider
  implements ProfileCookieSourceProvider
{
  private discovery?: { expiresAt: number; value: DiscoveredChromeProfile[] };

  constructor(
    private readonly source: BrowserLoginSourceAdapter,
    private readonly readCookies: (
      databasePath: string,
    ) => Promise<ChromeCookieReadResult>,
    private readonly now: () => number = Date.now,
  ) {}

  supports(source: BrowserProfileSource) {
    return source.type === "chrome";
  }

  async snapshot(
    profile: BrowserProfileRecord,
    previousRevision?: string,
  ): Promise<ProfileCookieSourceSnapshot> {
    if (profile.source?.type !== "chrome") {
      throw new Error("unsupported profile sync source");
    }
    const profileDirName = profile.source.profileDirName;
    const discovered = (await this.discover()).find(
      (candidate) => candidate.profileDirName === profileDirName,
    );
    if (!discovered) throw new Error("profile-sync-source-missing");
    const databasePath = await chromeCookieDatabase(discovered.profilePath);
    const revision = await fileSetRevision([
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]);
    if (previousRevision && revision === previousRevision) {
      return { unchanged: true, revision };
    }
    return {
      unchanged: false,
      revision,
      cookies: (await this.readCookies(databasePath)).cookies,
    };
  }

  private async discover() {
    const now = this.now();
    if (this.discovery && this.discovery.expiresAt > now) {
      return this.discovery.value;
    }
    const value = await this.source.discover();
    this.discovery = { expiresAt: now + 5_000, value };
    return value;
  }
}

export class UfoProfileCookieSourceProvider
  implements ProfileCookieSourceProvider
{
  constructor(
    private readonly getProfile: (profileId: string) => BrowserProfileRecord,
    private readonly createTarget: (
      profile: BrowserProfileRecord,
    ) => Promise<CookieWriteTarget>,
  ) {}

  supports(source: BrowserProfileSource) {
    return source.type === "ufo";
  }

  async snapshot(profile: BrowserProfileRecord): Promise<ProfileCookieSourceSnapshot> {
    if (profile.source?.type !== "ufo") {
      throw new Error("unsupported profile sync source");
    }
    const sourceProfile = this.getProfile(profile.source.profileId);
    const target = await this.createTarget(sourceProfile);
    try {
      return { unchanged: false, cookies: await readProfileCookies(target) };
    } finally {
      await target.dispose();
    }
  }
}

async function chromeCookieDatabase(profilePath: string) {
  for (const candidate of [
    join(profilePath, "Network", "Cookies"),
    join(profilePath, "Cookies"),
  ]) {
    try {
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return candidate;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("profile-sync-cookie-database-missing");
}

async function fileSetRevision(paths: readonly string[]) {
  const hash = createHash("sha256");
  for (const path of paths) {
    try {
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) continue;
      hash.update(`${path.split("/").at(-1)}:${info.size}:${info.mtimeNs}\n`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return hash.digest("hex");
}
