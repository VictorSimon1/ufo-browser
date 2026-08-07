import { join } from "node:path";
import type { KeychainProvider } from "./keychain.js";
import { KeychainError } from "./keychain.js";
import {
  defaultChromeUserDataPath,
  createChromeStableSourceAdapter,
  type DiscoveredChromeProfile,
  type BrowserLoginSourceAdapter,
} from "./discovery.js";
import {
  readChromeCookies,
  type ChromeCookieReadResult,
} from "./cookies.js";
import {
  writeAndVerifyCookies,
  type CookieWriteTarget,
} from "./cookie-writer.js";
import { ChromeImportTransaction } from "./transaction.js";
import type { BrowserProfileRegistry } from "../profile-registry.js";

export type ChromeImportProgress = {
  phase: string;
  completed: number;
  total: number;
  detailCode?: string;
};

export type ChromeImportResult = {
  status: "success" | "partial";
  profile: { id: string; name: string; isDefault: boolean };
  cookies: {
    imported: number;
    partitioned: number;
    skipped: number;
    warningCodes: Array<{ code: string; count: number }>;
  };
  storage: {
    copied: string[];
    skipped: string[];
    warningCodes: Array<{ code: string; count: number }>;
  };
};

export class ChromeImportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ChromeImportError";
  }
}

export type ChromeLoginImportServiceOptions = {
  userDataPath: string;
  partitionsRoot: string;
  profiles: BrowserProfileRegistry;
  keychain: KeychainProvider;
  targetChromiumVersion: string;
  chromeUserDataPath?: string;
  createTarget: (profileId: string, partitionId: string) => Promise<CookieWriteTarget>;
  readCookies?: (databasePath: string) => Promise<ChromeCookieReadResult>;
  sourceAdapter?: BrowserLoginSourceAdapter;
};

export class ChromeLoginImportService {
  private readonly source: BrowserLoginSourceAdapter;

  constructor(private readonly options: ChromeLoginImportServiceOptions) {
    this.source =
      options.sourceAdapter ??
      createChromeStableSourceAdapter(
        options.chromeUserDataPath ?? defaultChromeUserDataPath(),
      );
  }

  async discover() {
    try {
      const [profiles, running] = await Promise.all([
        this.source.discover(),
        this.source.running(),
      ]);
      return {
        running: running.running,
        profiles: profiles.map(sanitizeDiscoveredProfile),
      };
    } catch {
      throw new ChromeImportError("chrome-discovery-failed");
    }
  }

  async quitChrome() {
    try {
      return await this.source.quit();
    } catch {
      throw new ChromeImportError("chrome-quit-failed");
    }
  }

  async importProfile(
    profileDirName: string,
    makeDefault: boolean,
    allowPartial: boolean,
    onProgress: (progress: ChromeImportProgress) => void = () => undefined,
  ): Promise<ChromeImportResult> {
    let transaction: ChromeImportTransaction | undefined;
    let target: CookieWriteTarget | undefined;
    let targetCreated = false;
    const reportProgress = (progress: ChromeImportProgress) => {
      try {
        onProgress(progress);
      } catch {
        // Renderer progress observers are not part of the import transaction.
      }
    };
    try {
      await this.assertSourceStopped();
      const source = (await this.source.discover()).find(
        (profile) => profile.profileDirName === profileDirName,
      );
      if (!source) throw new ChromeImportError("chrome-profile-not-found");
      await this.assertSourceStopped();
      reportProgress({
        phase: "snapshotting",
        completed: 0,
        total: 4,
        detailCode: "preparing",
      });
      transaction = await ChromeImportTransaction.create({
        jobsRoot: join(this.options.userDataPath, "Chrome Import", "jobs"),
        partitionsRoot: this.options.partitionsRoot,
        source,
        targetChromiumVersion: this.options.targetChromiumVersion,
        onSnapshotProgress: (progress) =>
          reportProgress({
            phase: "snapshotting",
            completed:
              progress.total > 0 ? progress.completed / progress.total : 0,
            total: 4,
            detailCode: progress.item,
          }),
      });
      const snapshot = await transaction.snapshot();
      await this.assertSourceStopped();
      await transaction.activateStorage();

      reportProgress({ phase: "importing-cookies", completed: 1, total: 4 });
      await transaction.setPhase("importing-cookies");
      const cookieResult = snapshot.storage.cookieDatabasePresent
        ? await (this.options.readCookies
            ? this.options.readCookies(transaction.stagedCookieDatabasePath)
            : readChromeCookies(
                transaction.stagedCookieDatabasePath,
                this.options.keychain,
              ))
        : { databaseVersion: 0, cookies: [], warnings: [] };
      if (
        cookieResult.cookies.length === 0 &&
        cookieResult.warnings.some((warning) =>
          [
            "decryption-failed",
            "host-digest-mismatch",
            "invalid-utf8",
          ].includes(warning.code),
        )
      ) {
        throw new ChromeImportError("cookie-decryption-failed");
      }
      target = await this.options.createTarget(
        snapshot.target.profileId,
        snapshot.target.partitionId,
      );
      targetCreated = true;
      const writeResult = await writeAndVerifyCookies(target, cookieResult.cookies);

      reportProgress({ phase: "verifying", completed: 3, total: 4 });
      const significantWarnings = cookieResult.warnings.filter(
        (warning) => warning.code !== "expired-cookie",
      );
      const status =
        !snapshot.storage.cookieDatabasePresent ||
        significantWarnings.length ||
        snapshot.storage.warningCodes.length
          ? "partial"
          : "success";
      if (status === "partial" && !allowPartial) {
        throw new ChromeImportError("partial-import-not-approved");
      }
      await transaction.setPhase(status === "partial" ? "partial" : "verifying");
      await target.dispose();
      target = undefined;
      const profile = await transaction.publish(
        this.options.profiles,
        status,
        makeDefault,
      );
      reportProgress({ phase: "committed", completed: 4, total: 4 });
      return {
        status,
        profile: {
          id: profile.id,
          name: profile.name,
          isDefault: this.options.profiles.getDefault().id === profile.id,
        },
        cookies: {
          imported: writeResult.written,
          partitioned: writeResult.partitioned,
          skipped: cookieResult.warnings.reduce(
            (total, warning) => total + warning.count,
            0,
          ),
          warningCodes: cookieResult.warnings,
        },
        storage: {
          copied: snapshot.storage.copied,
          skipped: snapshot.storage.skipped,
          warningCodes: countWarningCodes(snapshot.storage.warningCodes),
        },
      };
    } catch (error) {
      try {
        await target?.dispose();
      } catch {
        // The import journal still prevents a partially initialized profile
        // from being published when a hidden target cannot close cleanly.
      }
      await transaction?.fail(importErrorCode(error), targetCreated).catch(
        () => undefined,
      );
      if (error instanceof ChromeImportError) throw error;
      throw new ChromeImportError(importErrorCode(error));
    }
  }

  private async assertSourceStopped() {
    if ((await this.source.running()).running) {
      throw new ChromeImportError("chrome-running");
    }
  }
}

function countWarningCodes(codes: readonly string[]) {
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts.entries()].map(([code, count]) => ({ code, count }));
}

function sanitizeDiscoveredProfile(profile: DiscoveredChromeProfile) {
  return {
    browser: profile.browser,
    browserName: profile.browserName,
    browserVersion: profile.browserVersion,
    profileDirName: profile.profileDirName,
    displayName: profile.displayName,
    isDefault: profile.isDefault,
    isLastUsed: profile.isLastUsed,
    activeAt: profile.activeAt,
    approximateImportBytes: profile.approximateImportBytes,
  };
}

function importErrorCode(error: unknown) {
  if (error instanceof ChromeImportError || error instanceof KeychainError) {
    return error.code;
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("verification failed")) return "cookie-verification-failed";
  if (message.includes("target browser profile partition")) {
    return "target-profile-conflict";
  }
  if (message.includes("database")) return "cookie-database-invalid";
  return "chrome-import-failed";
}
