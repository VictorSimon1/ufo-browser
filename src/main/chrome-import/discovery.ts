import { homedir } from "node:os";
import { spawn } from "node:child_process";
import {
  lstat,
  opendir,
  readFile,
  readlink,
  realpath,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { discoverChromeProfileAvatar } from "../profile-avatar-store.js";

export const CHROME_PROFILE_DIRECTORY_PATTERN = /^(Default|Profile [1-9][0-9]*)$/;

const CHROME_EPOCH_OFFSET_MICROSECONDS = 11_644_473_600_000_000n;
const IMPORT_STORAGE_SIZE_PATHS = [
  "Local Storage",
  "IndexedDB",
  "WebStorage",
  "File System",
  "Storage",
  "QuotaManager",
  "QuotaManager-journal",
  "Service Worker",
] as const;
const DISCOVERY_SIZE_BUDGET_MS = 350;
const DISCOVERY_SIZE_ENTRY_LIMIT = 20_000;
const DISCOVERY_SIZE_BATCH_SIZE = 32;

export type ChromeRunningState = {
  running: boolean;
  pid?: number;
  reason?: "singleton-lock";
};

export type DiscoveredChromeProfile = {
  browser: "chrome";
  browserName: "Google Chrome";
  browserVersion?: string;
  userDataPath: string;
  profilePath: string;
  profileDirName: string;
  displayName: string;
  isDefault: boolean;
  isLastUsed: boolean;
  activeAt?: number;
  approximateImportBytes: number;
  avatarPath?: string;
};

export interface BrowserLoginSourceAdapter {
  readonly browser: string;
  readonly browserName: string;
  discover(): Promise<DiscoveredChromeProfile[]>;
  running(): Promise<ChromeRunningState>;
  quit(): Promise<{ done: boolean }>;
}

export function createChromeStableSourceAdapter(
  userDataPath = defaultChromeUserDataPath(),
): BrowserLoginSourceAdapter {
  return {
    browser: "chrome",
    browserName: "Google Chrome",
    discover: () => discoverChromeProfiles(userDataPath),
    running: () => detectChromeRunning(userDataPath),
    quit: () => requestChromeQuit(userDataPath),
  };
}

export function defaultChromeUserDataPath(home = homedir()) {
  return join(home, "Library", "Application Support", "Google", "Chrome");
}

export async function discoverChromeProfiles(
  userDataPath = defaultChromeUserDataPath(),
): Promise<DiscoveredChromeProfile[]> {
  let userDataRealPath: string;
  let localState: any;
  try {
    userDataRealPath = await realpath(userDataPath);
    localState = JSON.parse(await readFile(join(userDataRealPath, "Local State"), "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }

  const infoCache = localState?.profile?.info_cache;
  if (!infoCache || typeof infoCache !== "object" || Array.isArray(infoCache)) {
    return [];
  }
  const lastUsed =
    typeof localState?.profile?.last_used === "string"
      ? localState.profile.last_used
      : Array.isArray(localState?.profile?.last_active_profiles)
        ? localState.profile.last_active_profiles.find(
            (value: unknown): value is string => typeof value === "string",
          )
        : undefined;
  const browserVersion = await readBrowserVersion(userDataRealPath);
  const profiles: DiscoveredChromeProfile[] = [];
  const sizeDeadline = Date.now() + DISCOVERY_SIZE_BUDGET_MS;

  for (const profileDirName of Object.keys(infoCache).sort(profileDirectoryOrder)) {
    if (!CHROME_PROFILE_DIRECTORY_PATTERN.test(profileDirName)) continue;
    const profilePath = resolve(userDataRealPath, profileDirName);
    if (!isDirectChild(userDataRealPath, profilePath)) continue;
    let profileRealPath: string;
    try {
      const profileStat = await lstat(profilePath);
      if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) continue;
      profileRealPath = await realpath(profilePath);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!isDirectChild(userDataRealPath, profileRealPath)) continue;

    const info = infoCache[profileDirName];
    const displayName =
      typeof info?.name === "string" && info.name.trim()
        ? info.name.trim().slice(0, 160)
        : profileDirName;
    profiles.push({
      browser: "chrome",
      browserName: "Google Chrome",
      browserVersion,
      userDataPath: userDataRealPath,
      profilePath: profileRealPath,
      profileDirName,
      displayName,
      isDefault: profileDirName === "Default",
      isLastUsed: profileDirName === lastUsed,
      activeAt: chromeTimeToUnixMilliseconds(info?.active_time),
      approximateImportBytes: await estimateChromeImportBytes(
        profileRealPath,
        { deadline: sizeDeadline },
      ),
      avatarPath: await discoverChromeProfileAvatar(profileRealPath, info),
    });
  }
  return profiles;
}

export async function detectChromeRunning(
  userDataPath = defaultChromeUserDataPath(),
): Promise<ChromeRunningState> {
  const lockPath = join(userDataPath, "SingletonLock");
  let lockStat;
  try {
    lockStat = await lstat(lockPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { running: false };
    throw error;
  }
  if (!lockStat.isSymbolicLink() && !lockStat.isFile()) {
    return { running: true, reason: "singleton-lock" };
  }
  let target = "";
  try {
    target = lockStat.isSymbolicLink()
      ? await readlink(lockPath)
      : await readFile(lockPath, "utf8");
  } catch {
    return { running: true, reason: "singleton-lock" };
  }
  const match = target.trim().match(/-([1-9][0-9]*)$/);
  const pid = match ? Number(match[1]) : undefined;
  if (pid && Number.isSafeInteger(pid)) {
    try {
      process.kill(pid, 0);
      return { running: true, pid, reason: "singleton-lock" };
    } catch (error: any) {
      if (error?.code === "EPERM") {
        return { running: true, pid, reason: "singleton-lock" };
      }
      if (error?.code === "ESRCH") return { running: false };
    }
  }
  return { running: true, reason: "singleton-lock" };
}

export async function requestChromeQuit(
  userDataPath = defaultChromeUserDataPath(),
  timeoutMs = 20_000,
) {
  if (process.platform !== "darwin") {
    throw new Error("Chrome quit is only available on macOS");
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      "/usr/bin/osascript",
      ["-e", 'tell application "Google Chrome" to quit'],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error("Chrome did not accept the quit request"));
    });
  });
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < deadline) {
    if (!(await detectChromeRunning(userDataPath)).running) return { done: true };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Chrome is still running");
}

export function chromeTimeToUnixMilliseconds(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  try {
    const microseconds = BigInt(String(value));
    if (microseconds <= CHROME_EPOCH_OFFSET_MICROSECONDS) return undefined;
    const milliseconds = Number(
      (microseconds - CHROME_EPOCH_OFFSET_MICROSECONDS) / 1_000n,
    );
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  } catch {
    return undefined;
  }
}

async function readBrowserVersion(userDataPath: string) {
  try {
    const value = (await readFile(join(userDataPath, "Last Version"), "utf8")).trim();
    return /^\d+(?:\.\d+){1,3}$/.test(value) ? value : undefined;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function estimateChromeImportBytes(
  profilePath: string,
  options: {
    budgetMs?: number;
    deadline?: number;
    maxEntries?: number;
    now?: () => number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const deadline =
    options.deadline ?? now() + (options.budgetMs ?? DISCOVERY_SIZE_BUDGET_MS);
  const maxEntries = Math.max(
    1,
    Math.floor(options.maxEntries ?? DISCOVERY_SIZE_ENTRY_LIMIT),
  );
  const modernCookies = join(profilePath, "Network", "Cookies");
  const legacyCookies = join(profilePath, "Cookies");
  const cookiePath = await firstSafeSizePath([
    modernCookies,
    legacyCookies,
  ]);
  const pending = [
    ...(cookiePath ? [cookiePath] : []),
    ...IMPORT_STORAGE_SIZE_PATHS.map((relativePath) =>
      join(profilePath, relativePath),
    ),
  ];
  let inspected = 0;
  let total = 0;

  while (pending.length > 0 && inspected < maxEntries && now() < deadline) {
    const batch = pending.splice(
      0,
      Math.min(
        DISCOVERY_SIZE_BATCH_SIZE,
        maxEntries - inspected,
      ),
    );
    const nodes = await Promise.all(
      batch.map(async (path) => {
        try {
          const info = await lstat(path);
          if (info.isSymbolicLink()) return undefined;
          return { path, info };
        } catch (error: any) {
          if (isSkippableSizeError(error)) return undefined;
          throw error;
        }
      }),
    );
    inspected += batch.length;
    for (const node of nodes) {
      if (!node) continue;
      if (node.info.isFile()) {
        total += node.info.size;
        continue;
      }
      if (!node.info.isDirectory() || now() >= deadline) continue;
      try {
        const directory = await opendir(node.path, {
          bufferSize: DISCOVERY_SIZE_BATCH_SIZE,
        });
        for await (const entry of directory) {
          if (now() >= deadline || inspected + pending.length >= maxEntries) {
            break;
          }
          if (!entry.isSymbolicLink()) {
            pending.push(join(node.path, entry.name));
          }
        }
      } catch (error: any) {
        if (!isSkippableSizeError(error)) throw error;
      }
    }
  }
  return total;
}

async function firstSafeSizePath(paths: readonly string[]) {
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (!info.isSymbolicLink() && info.isFile()) return path;
    } catch (error: any) {
      if (!isSkippableSizeError(error)) throw error;
    }
  }
  return undefined;
}

function isSkippableSizeError(error: any) {
  return error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM";
}

function isDirectChild(parent: string, child: string) {
  const candidate = relative(parent, child);
  return candidate === basename(child) && !candidate.includes(sep);
}

function profileDirectoryOrder(left: string, right: string) {
  if (left === "Default") return -1;
  if (right === "Default") return 1;
  return left.localeCompare(right, undefined, { numeric: true });
}
