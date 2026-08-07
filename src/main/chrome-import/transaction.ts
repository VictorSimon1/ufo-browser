import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { DiscoveredChromeProfile } from "./discovery.js";
import {
  BrowserProfileRegistry,
  isValidPartitionId,
  isValidProfileId,
  type BrowserProfileImportStatus,
  type BrowserProfileRecord,
} from "../profile-registry.js";

export type ChromeImportPhase =
  | "discovered"
  | "waiting-for-source-exit"
  | "snapshotting"
  | "preparing-profile"
  | "importing-storage"
  | "importing-cookies"
  | "verifying"
  | "publishing"
  | "committed"
  | "failed"
  | "partial"
  | "cleanup-pending";

export type ChromeImportManifest = {
  version: 1;
  id: string;
  phase: ChromeImportPhase;
  source: {
    browser: "chrome";
    profileDirName: string;
    displayName: string;
    browserVersion?: string;
  };
  compatibility: {
    sourceChromiumVersion?: string;
    targetChromiumVersion: string;
  };
  target: {
    profileId: string;
    partitionId: string;
    activated: boolean;
  };
  storage: {
    copied: string[];
    skipped: string[];
    warningCodes: string[];
    cookieDatabasePresent: boolean;
  };
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
};

export type ChromeImportTransactionOptions = {
  jobsRoot: string;
  partitionsRoot: string;
  source: DiscoveredChromeProfile;
  targetChromiumVersion: string;
  copyStorageTree?: (sourcePath: string, targetPath: string) => Promise<void>;
  id?: string;
  now?: () => number;
};

const REQUIRED_STORAGE_PATHS = [
  "Local Storage",
  "IndexedDB",
  "WebStorage",
  "File System",
  "Storage",
  "QuotaManager",
  "QuotaManager-journal",
] as const;
const OPTIONAL_SERVICE_WORKER_PATH = "Service Worker";

export class ChromeImportTransaction {
  readonly jobRoot: string;
  readonly stagedPartitionPath: string;
  readonly targetPartitionPath: string;
  readonly stagedCookieDatabasePath: string;
  private manifest: ChromeImportManifest;

  private constructor(private readonly options: ChromeImportTransactionOptions) {
    const id = options.id ?? randomUUID();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(id) || id.includes("..")) {
      throw new Error("invalid Chrome import job id");
    }
    const suffix = id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
    const now = (options.now ?? Date.now)();
    const profileId = `chrome-${suffix}`;
    const partitionId = `x-browser-profile-${profileId}`;
    if (!isValidProfileId(profileId) || !isValidPartitionId(partitionId)) {
      throw new Error("invalid Chrome import job id");
    }
    this.jobRoot = join(options.jobsRoot, id);
    this.stagedPartitionPath = join(this.jobRoot, "partition");
    this.targetPartitionPath = join(options.partitionsRoot, partitionId);
    this.stagedCookieDatabasePath = join(this.jobRoot, "source", "Cookies");
    this.manifest = {
      version: 1,
      id,
      phase: "discovered",
      source: {
        browser: "chrome",
        profileDirName: options.source.profileDirName,
        displayName: options.source.displayName,
        browserVersion: options.source.browserVersion,
      },
      compatibility: {
        sourceChromiumVersion: options.source.browserVersion,
        targetChromiumVersion: options.targetChromiumVersion,
      },
      target: { profileId, partitionId, activated: false },
      storage: {
        copied: [],
        skipped: [],
        warningCodes: [],
        cookieDatabasePresent: false,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  static async create(options: ChromeImportTransactionOptions) {
    const transaction = new ChromeImportTransaction(options);
    await mkdir(options.jobsRoot, { recursive: true, mode: 0o700 });
    await mkdir(transaction.jobRoot, { recursive: false, mode: 0o700 });
    await transaction.writeManifest();
    return transaction;
  }

  state() {
    return structuredClone(this.manifest);
  }

  async setPhase(phase: ChromeImportPhase) {
    this.manifest.phase = phase;
    this.manifest.updatedAt = (this.options.now ?? Date.now)();
    await this.writeManifest();
  }

  async snapshot() {
    await this.setPhase("snapshotting");
    try {
      const sourceProfilePath = await validateSourceProfile(this.options.source);
      await mkdir(join(this.jobRoot, "source"), { recursive: true, mode: 0o700 });
      await mkdir(this.stagedPartitionPath, { recursive: false, mode: 0o700 });
      await this.copyCookieDatabase(sourceProfilePath);

      const paths: string[] = [...REQUIRED_STORAGE_PATHS];
      if (serviceWorkerCompatible(
        this.options.source.browserVersion,
        this.options.targetChromiumVersion,
      )) {
        paths.push(OPTIONAL_SERVICE_WORKER_PATH);
      } else {
        this.manifest.storage.skipped.push(OPTIONAL_SERVICE_WORKER_PATH);
        this.manifest.storage.warningCodes.push(
          "service-worker-version-mismatch",
        );
      }
      for (const relativePath of paths) {
        const sourcePath = join(sourceProfilePath, relativePath);
        const targetPath = join(this.stagedPartitionPath, relativePath);
        if (!(await pathExists(sourcePath))) {
          this.manifest.storage.skipped.push(relativePath);
          continue;
        }
        try {
          await (this.options.copyStorageTree ?? copyTreeSafely)(
            sourcePath,
            targetPath,
          );
          this.manifest.storage.copied.push(relativePath);
        } catch (error) {
          if (relativePath !== OPTIONAL_SERVICE_WORKER_PATH) throw error;
          await rm(targetPath, { recursive: true, force: true });
          this.manifest.storage.skipped.push(relativePath);
          this.manifest.storage.warningCodes.push(
            "service-worker-copy-failed",
          );
        }
      }
      await this.setPhase("preparing-profile");
      return this.state();
    } catch (error) {
      await this.fail("snapshot-failed", false);
      throw error;
    }
  }

  async activateStorage() {
    if (this.manifest.phase !== "preparing-profile") {
      throw new Error("Chrome import storage is not prepared");
    }
    if (await pathExists(this.targetPartitionPath)) {
      throw new Error("target browser profile partition already exists");
    }
    await mkdir(this.options.partitionsRoot, { recursive: true, mode: 0o700 });
    await rename(this.stagedPartitionPath, this.targetPartitionPath);
    this.manifest.target.activated = true;
    await this.setPhase("importing-storage");
  }

  async publish(
    registry: BrowserProfileRegistry,
    status: BrowserProfileImportStatus,
    makeDefault: boolean,
  ) {
    if (!this.manifest.target.activated) {
      throw new Error("Chrome import partition is not active");
    }
    if (this.manifest.phase !== "verifying" && this.manifest.phase !== "partial") {
      throw new Error("Chrome import has not been verified");
    }
    await this.setPhase("publishing");
    const now = (this.options.now ?? Date.now)();
    const profile: BrowserProfileRecord = {
      id: this.manifest.target.profileId,
      partitionId: this.manifest.target.partitionId,
      name: `Chrome - ${this.manifest.source.displayName}`,
      kind: "imported",
      source: {
        browser: "chrome",
        profileDirName: this.manifest.source.profileDirName,
        displayName: this.manifest.source.displayName,
        importedAt: now,
        lastImportStatus: status,
        loginSyncEnabled: false,
      },
      createdAt: now,
      updatedAt: now,
    };
    await registry.add(profile, makeDefault);
    await this.setPhase("committed");
    await rm(this.jobRoot, { recursive: true, force: true });
    return profile;
  }

  async fail(code: string, targetSessionCreated: boolean) {
    this.manifest.failureCode = sanitizeFailureCode(code);
    this.manifest.phase = targetSessionCreated ? "cleanup-pending" : "failed";
    this.manifest.updatedAt = (this.options.now ?? Date.now)();
    await this.writeManifest().catch(() => undefined);
    if (!targetSessionCreated) {
      await removeUnpublishedTransaction(this.jobRoot, this.targetPartitionPath);
    }
  }

  private async copyCookieDatabase(sourceProfilePath: string) {
    const candidates = [
      join(sourceProfilePath, "Network", "Cookies"),
      join(sourceProfilePath, "Cookies"),
    ];
    const sourcePath = await firstExistingPath(candidates);
    if (!sourcePath) return;
    await copyTreeSafely(sourcePath, this.stagedCookieDatabasePath);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${sourcePath}${suffix}`;
      if (await pathExists(sidecar)) {
        await copyTreeSafely(sidecar, `${this.stagedCookieDatabasePath}${suffix}`);
      }
    }
    this.manifest.storage.cookieDatabasePresent = true;
  }

  private async writeManifest() {
    await mkdir(this.jobRoot, { recursive: true, mode: 0o700 });
    const path = join(this.jobRoot, "job.json");
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  }
}

export async function recoverChromeImportJobs(
  jobsRoot: string,
  partitionsRoot: string,
  publishedPartitionIds: ReadonlySet<string>,
) {
  let entries;
  try {
    entries = await readdir(jobsRoot, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return { recovered: 0, preserved: 0 };
    throw error;
  }
  let recovered = 0;
  let preserved = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const jobRoot = join(jobsRoot, entry.name);
    const manifest = await readManifest(join(jobRoot, "job.json"));
    if (!manifest || !isValidPartitionId(manifest.target.partitionId)) {
      await rm(jobRoot, { recursive: true, force: true });
      recovered++;
      continue;
    }
    if (publishedPartitionIds.has(manifest.target.partitionId)) {
      await rm(jobRoot, { recursive: true, force: true });
      preserved++;
      continue;
    }
    const targetPartition = resolve(partitionsRoot, manifest.target.partitionId);
    if (isDirectChild(resolve(partitionsRoot), targetPartition)) {
      await rm(targetPartition, { recursive: true, force: true });
    }
    await rm(jobRoot, { recursive: true, force: true });
    recovered++;
  }
  return { recovered, preserved };
}

async function validateSourceProfile(source: DiscoveredChromeProfile) {
  const unresolvedProfileInfo = await lstat(source.profilePath);
  if (
    !unresolvedProfileInfo.isDirectory() ||
    unresolvedProfileInfo.isSymbolicLink()
  ) {
    throw new Error("Chrome profile is not a safe directory");
  }
  const userDataPath = await realpath(source.userDataPath);
  const profilePath = await realpath(source.profilePath);
  if (!isDirectChild(userDataPath, profilePath)) {
    throw new Error("Chrome profile escaped its User Data directory");
  }
  if (basename(profilePath) !== source.profileDirName) {
    throw new Error("Chrome profile directory changed after discovery");
  }
  const info = await lstat(profilePath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Chrome profile is not a safe directory");
  }
  return profilePath;
}

async function copyTreeSafely(sourcePath: string, targetPath: string): Promise<void> {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await mkdir(targetPath, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      await copyTreeSafely(
        join(sourcePath, entry.name),
        join(targetPath, entry.name),
      );
    }
    await chmod(targetPath, 0o700);
    return;
  }
  if (!info.isFile()) return;
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE);
  await chmod(targetPath, 0o600);
}

function serviceWorkerCompatible(
  sourceVersion: string | undefined,
  targetVersion: string,
) {
  const sourceMajor = Number(sourceVersion?.split(".")[0]);
  const targetMajor = Number(targetVersion.split(".")[0]);
  return (
    Number.isSafeInteger(sourceMajor) &&
    Number.isSafeInteger(targetMajor) &&
    sourceMajor <= targetMajor + 1
  );
}

async function readManifest(path: string): Promise<ChromeImportManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (
      parsed?.version !== 1 ||
      typeof parsed?.target?.partitionId !== "string"
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function removeUnpublishedTransaction(jobRoot: string, targetPath: string) {
  await rm(targetPath, { recursive: true, force: true });
  await rm(jobRoot, { recursive: true, force: true });
}

async function firstExistingPath(paths: string[]) {
  for (const path of paths) if (await pathExists(path)) return path;
  return undefined;
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isDirectChild(parent: string, child: string) {
  const candidate = relative(parent, child);
  return candidate === basename(child) && !candidate.includes(sep);
}

function sanitizeFailureCode(code: string) {
  const sanitized = code.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80);
  return sanitized || "import-failed";
}
