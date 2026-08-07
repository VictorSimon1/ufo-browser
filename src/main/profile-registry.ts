import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_PROFILE_ID = "default";
export const DEFAULT_PROFILE_PARTITION_ID = "x-browser-profile-default";

export type BrowserProfileKind = "local" | "imported";
export type BrowserProfileImportStatus = "success" | "partial";

export type BrowserProfileSource = {
  browser: "chrome";
  profileDirName: string;
  displayName: string;
  importedAt: number;
  lastImportStatus: BrowserProfileImportStatus;
  loginSyncEnabled: false;
};

export type BrowserProfileRecord = {
  id: string;
  partitionId: string;
  name: string;
  kind: BrowserProfileKind;
  source?: BrowserProfileSource;
  createdAt: number;
  updatedAt: number;
};

export type BrowserProfileState = {
  version: 1;
  defaultProfileId: string;
  profiles: BrowserProfileRecord[];
};

export type PublicBrowserProfile = {
  id: string;
  isDefault: boolean;
  name: string;
  kind: BrowserProfileKind;
  source?: Omit<BrowserProfileSource, "displayName"> & { displayName: string };
};

export function isValidProfileId(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}

export function isValidPartitionId(value: string) {
  return /^x-browser-profile-[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}

export class BrowserProfileRegistry {
  private state: BrowserProfileState = createDefaultProfileState();
  private writeQueue = Promise.resolve();

  constructor(readonly path: string) {}

  async initialize() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      this.state = validateProfileState(parsed);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      this.state = createDefaultProfileState();
      await this.save();
    }
  }

  list(): BrowserProfileRecord[] {
    return structuredClone(this.state.profiles);
  }

  listPublic(): PublicBrowserProfile[] {
    return this.state.profiles.map((profile) => ({
      id: profile.id === DEFAULT_PROFILE_ID ? "Default" : profile.id,
      isDefault: profile.id === this.state.defaultProfileId,
      name: profile.name,
      kind: profile.kind,
      source: profile.source ? structuredClone(profile.source) : undefined,
    }));
  }

  getDefault(): BrowserProfileRecord {
    return this.getOrThrow(this.state.defaultProfileId);
  }

  getOrThrow(profileId: string): BrowserProfileRecord {
    const normalized = profileId === "Default" ? DEFAULT_PROFILE_ID : profileId;
    const profile = this.state.profiles.find((candidate) => candidate.id === normalized);
    if (!profile) throw new Error(`browser profile not found: ${profileId}`);
    return structuredClone(profile);
  }

  async add(profile: BrowserProfileRecord, makeDefault = false) {
    validateProfileRecord(profile);
    if (this.state.profiles.some((candidate) => candidate.id === profile.id)) {
      throw new Error(`browser profile already exists: ${profile.id}`);
    }
    if (
      this.state.profiles.some(
        (candidate) => candidate.partitionId === profile.partitionId,
      )
    ) {
      throw new Error(`browser partition already exists: ${profile.partitionId}`);
    }
    this.state.profiles.push(structuredClone(profile));
    if (makeDefault) this.state.defaultProfileId = profile.id;
    await this.save();
    return this.getOrThrow(profile.id);
  }

  async setDefault(profileId: string) {
    const profile = this.getOrThrow(profileId);
    this.state.defaultProfileId = profile.id;
    await this.save();
  }

  private save(): Promise<void> {
    const snapshot = structuredClone(this.state);
    this.writeQueue = this.writeQueue.then(() => this.writeAtomically(snapshot));
    return this.writeQueue;
  }

  private async writeAtomically(state: BrowserProfileState) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.path);
  }
}

function createDefaultProfileState(now = Date.now()): BrowserProfileState {
  return {
    version: 1,
    defaultProfileId: DEFAULT_PROFILE_ID,
    profiles: [
      {
        id: DEFAULT_PROFILE_ID,
        partitionId: DEFAULT_PROFILE_PARTITION_ID,
        name: "您的 UFO-Browser",
        kind: "local",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function validateProfileState(input: unknown): BrowserProfileState {
  if (!input || typeof input !== "object") {
    throw new Error("invalid browser profile registry");
  }
  const state = input as BrowserProfileState;
  if (state.version !== 1 || !Array.isArray(state.profiles)) {
    throw new Error("unsupported browser profile registry");
  }
  if (!isValidProfileId(state.defaultProfileId)) {
    throw new Error("invalid default browser profile id");
  }
  const profileIds = new Set<string>();
  const partitionIds = new Set<string>();
  for (const profile of state.profiles) {
    validateProfileRecord(profile);
    if (profileIds.has(profile.id)) throw new Error("duplicate browser profile id");
    if (partitionIds.has(profile.partitionId)) {
      throw new Error("duplicate browser profile partition");
    }
    profileIds.add(profile.id);
    partitionIds.add(profile.partitionId);
  }
  if (!profileIds.has(state.defaultProfileId)) {
    throw new Error("default browser profile does not exist");
  }
  return structuredClone(state);
}

function validateProfileRecord(profile: BrowserProfileRecord) {
  if (!profile || typeof profile !== "object") {
    throw new Error("invalid browser profile");
  }
  if (!isValidProfileId(profile.id)) throw new Error("invalid browser profile id");
  if (!isValidPartitionId(profile.partitionId)) {
    throw new Error("invalid browser profile partition id");
  }
  if (typeof profile.name !== "string" || !profile.name.trim()) {
    throw new Error("invalid browser profile name");
  }
  if (profile.kind !== "local" && profile.kind !== "imported") {
    throw new Error("invalid browser profile kind");
  }
  if (!Number.isFinite(profile.createdAt) || !Number.isFinite(profile.updatedAt)) {
    throw new Error("invalid browser profile timestamps");
  }
  if (profile.kind === "imported") validateProfileSource(profile.source);
  if (profile.kind === "local" && profile.source !== undefined) {
    throw new Error("local browser profile cannot have an import source");
  }
}

function validateProfileSource(source: BrowserProfileSource | undefined) {
  if (!source || source.browser !== "chrome") {
    throw new Error("invalid browser profile source");
  }
  if (!/^(Default|Profile [1-9][0-9]*)$/.test(source.profileDirName)) {
    throw new Error("invalid source profile directory");
  }
  if (typeof source.displayName !== "string" || !source.displayName.trim()) {
    throw new Error("invalid source profile display name");
  }
  if (!Number.isFinite(source.importedAt)) {
    throw new Error("invalid browser profile import time");
  }
  if (source.lastImportStatus !== "success" && source.lastImportStatus !== "partial") {
    throw new Error("invalid browser profile import status");
  }
  if (source.loginSyncEnabled !== false) {
    throw new Error("browser login sync is not available");
  }
}
