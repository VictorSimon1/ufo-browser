import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export const DEFAULT_PROFILE_ID = "default";
export const DEFAULT_PROFILE_PARTITION_ID = "x-browser-profile-default";

export type BrowserProfileKind = "local" | "imported";
export type BrowserProfileImportStatus = "success" | "partial";

type BrowserProfileSourceCommon = {
  displayName: string;
  importedAt: number;
  lastImportStatus: BrowserProfileImportStatus;
  loginSyncEnabled: boolean;
};

export type ChromeBrowserProfileSource = BrowserProfileSourceCommon & {
  type: "chrome";
  browser: "chrome";
  profileDirName: string;
};

export type UfoBrowserProfileSource = BrowserProfileSourceCommon & {
  type: "ufo";
  browser: "ufo-browser";
  profileId: string;
};

export type BrowserProfileSource =
  | ChromeBrowserProfileSource
  | UfoBrowserProfileSource;

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
  version: 2;
  defaultProfileId: string;
  profiles: BrowserProfileRecord[];
  pendingPartitionCleanup: string[];
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
  private mutationQueue = Promise.resolve();

  constructor(readonly path: string) {}

  async initialize() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      this.state = validateProfileState(parsed);
      if (parsed?.version !== this.state.version) {
        await this.writeAtomically(this.state);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      this.state = createDefaultProfileState();
      await this.writeAtomically(this.state);
    }
  }

  list(): BrowserProfileRecord[] {
    return structuredClone(this.state.profiles);
  }

  listPublic(): PublicBrowserProfile[] {
    return this.state.profiles.map((profile) => ({
      id: profile.id,
      isDefault: profile.id === this.state.defaultProfileId,
      name: profile.name,
      kind: profile.kind,
      source: profile.source ? structuredClone(profile.source) : undefined,
    }));
  }

  getDefault(): BrowserProfileRecord {
    return this.getOrThrow(this.state.defaultProfileId);
  }

  partitionIds() {
    return new Set(this.state.profiles.map((profile) => profile.partitionId));
  }

  getOrThrow(profileId: string): BrowserProfileRecord {
    const normalized = profileId === "Default" ? DEFAULT_PROFILE_ID : profileId;
    const profile = this.state.profiles.find((candidate) => candidate.id === normalized);
    if (!profile) throw new Error(`browser profile not found: ${profileId}`);
    return structuredClone(profile);
  }

  async add(profile: BrowserProfileRecord, makeDefault = false) {
    validateProfileRecord(profile);
    return this.commitMutation((state) => {
      if (state.profiles.some((candidate) => candidate.id === profile.id)) {
        throw new Error(`browser profile already exists: ${profile.id}`);
      }
      if (
        state.profiles.some(
          (candidate) => candidate.partitionId === profile.partitionId,
        )
      ) {
        throw new Error(`browser partition already exists: ${profile.partitionId}`);
      }
      if (profile.source?.type === "ufo") {
        const sourceProfileId = profile.source.profileId;
        if (sourceProfileId === profile.id) {
          throw new Error("browser profile cannot clone itself");
        }
        if (
          !state.profiles.some(
            (candidate) => candidate.id === sourceProfileId,
          )
        ) {
          throw new Error("source UFO-Browser profile does not exist");
        }
      }
      state.profiles.push(structuredClone(profile));
      if (makeDefault) state.defaultProfileId = profile.id;
      return structuredClone(profile);
    });
  }

  async setDefault(profileId: string) {
    await this.commitMutation((state) => {
      const profile = getProfileFromState(state, profileId);
      state.defaultProfileId = profile.id;
    });
  }

  async setLoginSyncEnabled(profileId: string, enabled: boolean) {
    return this.commitMutation((state) => {
      const profile = getProfileFromState(state, profileId);
      if (profile.kind !== "imported" || !profile.source) {
        throw new Error("local browser profile cannot enable login sync");
      }
      profile.source.loginSyncEnabled = enabled === true;
      profile.updatedAt = Date.now();
      return structuredClone(profile);
    });
  }

  async remove(profileId: string) {
    return this.commitMutation((state) => {
      const profile = getProfileFromState(state, profileId);
      if (profile.kind !== "imported") {
        throw new Error("local browser profile cannot be removed");
      }
      if (
        state.profiles.some(
          (candidate) =>
            candidate.source?.type === "ufo" &&
            candidate.source.profileId === profile.id,
        )
      ) {
        throw new Error("browser profile is still used as a clone source");
      }
      state.profiles = state.profiles.filter(
        (candidate) => candidate.id !== profile.id,
      );
      if (state.defaultProfileId === profile.id) {
        state.defaultProfileId = DEFAULT_PROFILE_ID;
      }
      if (!state.pendingPartitionCleanup.includes(profile.partitionId)) {
        state.pendingPartitionCleanup.push(profile.partitionId);
      }
      return structuredClone(profile);
    });
  }

  pendingPartitionCleanup() {
    return [...this.state.pendingPartitionCleanup];
  }

  async completePartitionCleanup(partitionIds: readonly string[]) {
    const completed = new Set(partitionIds);
    await this.commitMutation((state) => {
      state.pendingPartitionCleanup = state.pendingPartitionCleanup.filter(
        (partitionId) => !completed.has(partitionId),
      );
    });
  }

  private commitMutation<T>(mutation: (state: BrowserProfileState) => T) {
    const operation = this.mutationQueue.then(async () => {
      const next = structuredClone(this.state);
      const result = mutation(next);
      await this.writeAtomically(next);
      this.state = next;
      return result;
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async writeAtomically(state: BrowserProfileState) {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.path);
  }
}

function getProfileFromState(state: BrowserProfileState, profileId: string) {
  const normalized = profileId === "Default" ? DEFAULT_PROFILE_ID : profileId;
  const profile = state.profiles.find((candidate) => candidate.id === normalized);
  if (!profile) throw new Error(`browser profile not found: ${profileId}`);
  return profile;
}

function createDefaultProfileState(now = Date.now()): BrowserProfileState {
  return {
    version: 2,
    defaultProfileId: DEFAULT_PROFILE_ID,
    pendingPartitionCleanup: [],
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
  const raw = input as BrowserProfileState | LegacyBrowserProfileState;
  if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.profiles)) {
    throw new Error("unsupported browser profile registry");
  }
  const state = migrateProfileState(raw);
  const pendingPartitionCleanup =
    state.pendingPartitionCleanup === undefined
      ? []
      : state.pendingPartitionCleanup;
  if (
    !Array.isArray(pendingPartitionCleanup) ||
    pendingPartitionCleanup.some(
      (partitionId) =>
        typeof partitionId !== "string" || !isValidPartitionId(partitionId),
    )
  ) {
    throw new Error("invalid pending browser profile cleanup");
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
  for (const profile of state.profiles) {
    if (profile.source?.type !== "ufo") continue;
    if (
      profile.source.profileId === profile.id ||
      !profileIds.has(profile.source.profileId)
    ) {
      throw new Error("source UFO-Browser profile does not exist");
    }
  }
  return structuredClone({ ...state, pendingPartitionCleanup });
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
  if (!source || (source.type !== "chrome" && source.type !== "ufo")) {
    throw new Error("invalid browser profile source");
  }
  if (source.type === "chrome") {
    if (
      source.browser !== "chrome" ||
      !/^(Default|Profile [1-9][0-9]*)$/.test(source.profileDirName)
    ) {
      throw new Error("invalid source Chrome profile");
    }
  } else if (
    source.browser !== "ufo-browser" ||
    !isValidProfileId(source.profileId)
  ) {
    throw new Error("invalid source UFO-Browser profile");
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
  if (typeof source.loginSyncEnabled !== "boolean") {
    throw new Error("invalid browser login sync setting");
  }
}

type LegacyBrowserProfileState = Omit<BrowserProfileState, "version" | "profiles"> & {
  version: 1;
  profiles: Array<
    Omit<BrowserProfileRecord, "source"> & {
      source?: Omit<ChromeBrowserProfileSource, "type" | "loginSyncEnabled"> & {
        loginSyncEnabled: false;
      };
    }
  >;
};

function migrateProfileState(
  state: BrowserProfileState | LegacyBrowserProfileState,
): BrowserProfileState {
  if (state.version === 2) return structuredClone(state);
  return {
    ...structuredClone(state),
    version: 2,
    profiles: state.profiles.map((profile) => ({
      ...profile,
      source: profile.source
        ? {
            ...profile.source,
            type: "chrome" as const,
            loginSyncEnabled: false,
          }
        : undefined,
    })),
  };
}

export async function cleanupPendingProfilePartitions(
  partitionsRoot: string,
  partitionIds: readonly string[],
) {
  const root = resolve(partitionsRoot);
  for (const partitionId of partitionIds) {
    if (!isValidPartitionId(partitionId)) {
      throw new Error("invalid pending browser profile partition id");
    }
    const target = resolve(root, partitionId);
    const child = relative(root, target);
    if (child !== partitionId || child.includes(sep)) {
      throw new Error("browser profile cleanup escaped partitions root");
    }
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        await rm(target, { force: true });
      } else {
        await rm(target, { recursive: true, force: true });
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
