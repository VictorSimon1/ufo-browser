import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHROME_STORAGE_PATHS } from "../chrome-import/storage-preflight.js";
import { isValidProfileId } from "../profile-registry.js";
import type { CookieSyncCheckpoint } from "./cookie-diff.js";

const STORAGE_DATASETS = new Set<string>(CHROME_STORAGE_PATHS);

export type ProfileSyncCheckpoint = {
  version: 1;
  profileId: string;
  sourceRevision?: string;
  cookies: CookieSyncCheckpoint;
  storage: Record<
    string,
    { sourceRevision: string | null; targetRevision: string | null; updatedAt: number }
  >;
  updatedAt: number;
};

export class ProfileSyncCheckpointStore {
  constructor(private readonly root: string) {}

  async load(profileId: string): Promise<ProfileSyncCheckpoint | undefined> {
    const path = this.path(profileId);
    try {
      return validateCheckpoint(JSON.parse(await readFile(path, "utf8")), profileId);
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(checkpoint: ProfileSyncCheckpoint) {
    const validated = validateCheckpoint(checkpoint, checkpoint.profileId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const path = this.path(checkpoint.profileId);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, {
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  }

  async remove(profileId: string) {
    await rm(this.path(profileId), { force: true });
  }

  private path(profileId: string) {
    if (!isValidProfileId(profileId)) {
      throw new Error("invalid profile sync checkpoint id");
    }
    return join(this.root, `${profileId}.json`);
  }
}

function validateCheckpoint(
  input: unknown,
  expectedProfileId: string,
): ProfileSyncCheckpoint {
  if (!input || typeof input !== "object") {
    throw new Error("invalid profile sync checkpoint");
  }
  const checkpoint = input as ProfileSyncCheckpoint;
  if (
    checkpoint.version !== 1 ||
    checkpoint.profileId !== expectedProfileId ||
    !isValidProfileId(checkpoint.profileId) ||
    !checkpoint.cookies ||
    typeof checkpoint.cookies !== "object" ||
    !checkpoint.storage ||
    typeof checkpoint.storage !== "object" ||
    !Number.isFinite(checkpoint.updatedAt)
  ) {
    throw new Error("invalid profile sync checkpoint");
  }
  if (
    checkpoint.sourceRevision !== undefined &&
    !isSha256(checkpoint.sourceRevision)
  ) {
    throw new Error("invalid profile sync source revision");
  }
  for (const [key, entry] of Object.entries(checkpoint.cookies)) {
    if (
      !isSha256(key) ||
      !entry ||
      (entry.sourceHash !== null && !isSha256(entry.sourceHash)) ||
      (entry.targetHash !== null && !isSha256(entry.targetHash)) ||
      !Number.isFinite(entry.updatedAt)
    ) {
      throw new Error("invalid profile Cookie sync checkpoint");
    }
  }
  for (const [dataset, entry] of Object.entries(checkpoint.storage)) {
    if (
      !STORAGE_DATASETS.has(dataset) ||
      !entry ||
      (entry.sourceRevision !== null && !isSha256(entry.sourceRevision)) ||
      (entry.targetRevision !== null && !isSha256(entry.targetRevision)) ||
      !Number.isFinite(entry.updatedAt)
    ) {
      throw new Error("invalid profile storage sync checkpoint");
    }
  }
  return structuredClone(checkpoint);
}

function isSha256(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
