import { DatabaseSync } from "node:sqlite";
import {
  lstat,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { basename, join } from "node:path";

export const CHROME_STORAGE_PATHS = [
  "Local Storage",
  "IndexedDB",
  "WebStorage",
  "File System",
  "Storage",
  "QuotaManager",
  "QuotaManager-journal",
  "Service Worker",
] as const;

export type ChromeStoragePath = (typeof CHROME_STORAGE_PATHS)[number];

export type StoragePreflightResult = {
  failed: ChromeStoragePath[];
  warningCodes: string[];
};

export type ChromeStorageInspection = StoragePreflightResult & {
  origins: {
    localStorage: string[];
    indexedDb: string[];
    quota: string[];
  };
};

const STORAGE_PATH_SET = new Set<string>(CHROME_STORAGE_PATHS);
const QUOTA_STORAGE_PATHS = [
  "WebStorage",
  "Storage",
  "QuotaManager",
  "QuotaManager-journal",
] as const satisfies readonly ChromeStoragePath[];
const LEVELDB_SCAN_BYTE_LIMIT = 16 * 1024 * 1024;
const QUOTA_QUICK_CHECK_BYTE_LIMIT = 64 * 1024 * 1024;
const ORIGIN_LIMIT = 256;

export async function inspectChromeStorageSnapshot(
  partitionPath: string,
  copiedStorage: readonly string[],
): Promise<ChromeStorageInspection> {
  const copied = new Set(
    copiedStorage.filter((value): value is ChromeStoragePath =>
      STORAGE_PATH_SET.has(value),
    ),
  );
  const failed = new Set<ChromeStoragePath>();
  const warningCodes = new Set<string>();
  const localStorageOrigins = new Set<string>();
  const indexedDbOrigins = new Set<string>();
  const quotaOrigins = new Set<string>();

  if (copied.has("Local Storage")) {
    const levelDbPath = join(partitionPath, "Local Storage", "leveldb");
    if (!(await levelDbStructureLooksValid(levelDbPath))) {
      failed.add("Local Storage");
      warningCodes.add("local-storage-incompatible");
    } else {
      for (const origin of await discoverLocalStorageOrigins(levelDbPath)) {
        localStorageOrigins.add(origin);
      }
    }
  }

  if (copied.has("IndexedDB")) {
    const indexedDbPath = join(partitionPath, "IndexedDB");
    let indexedDbCompatible = true;
    try {
      const entries = await readdir(indexedDbPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (!entry.name.endsWith(".indexeddb.leveldb")) continue;
        if (!(await levelDbStructureLooksValid(join(indexedDbPath, entry.name)))) {
          indexedDbCompatible = false;
          break;
        }
        const origin = indexedDbDirectoryOrigin(entry.name);
        if (origin && indexedDbOrigins.size < ORIGIN_LIMIT) {
          indexedDbOrigins.add(origin);
        }
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") indexedDbCompatible = false;
    }
    if (!indexedDbCompatible) {
      failed.add("IndexedDB");
      warningCodes.add("indexeddb-incompatible");
    }
  }

  if (copied.has("File System")) {
    const originsPath = join(partitionPath, "File System", "Origins");
    if (
      (await pathExists(originsPath)) &&
      !(await levelDbStructureLooksValid(originsPath))
    ) {
      failed.add("File System");
      warningCodes.add("file-system-incompatible");
    }
  }

  const copiedQuotaPaths = QUOTA_STORAGE_PATHS.filter((path) => copied.has(path));
  if (copiedQuotaPaths.length > 0) {
    const quotaInspection = await inspectQuotaDatabases(partitionPath);
    if (!quotaInspection.compatible) {
      for (const path of copiedQuotaPaths) failed.add(path);
      warningCodes.add("storage-metadata-incompatible");
    } else {
      for (const origin of quotaInspection.origins) quotaOrigins.add(origin);
    }
  }

  return {
    failed: [...failed],
    warningCodes: [...warningCodes],
    origins: {
      localStorage: [...localStorageOrigins],
      indexedDb: [...indexedDbOrigins],
      quota: [...quotaOrigins],
    },
  };
}

export async function removeFailedStoragePaths(
  partitionPath: string,
  failed: readonly string[],
) {
  for (const relativePath of new Set(failed)) {
    if (!STORAGE_PATH_SET.has(relativePath)) continue;
    const targetPath = join(partitionPath, relativePath);
    if (basename(targetPath) !== relativePath) continue;
    await rm(targetPath, { recursive: true, force: true });
  }
}

export async function preflightChromeStorageSnapshot(
  partitionPath: string,
  copiedStorage: readonly string[],
): Promise<StoragePreflightResult> {
  const inspection = await inspectChromeStorageSnapshot(
    partitionPath,
    copiedStorage,
  );
  await removeFailedStoragePaths(partitionPath, inspection.failed);
  return {
    failed: inspection.failed,
    warningCodes: inspection.warningCodes,
  };
}

export function indexedDbDirectoryOrigin(name: string) {
  const identifier = name.replace(/\.indexeddb\.leveldb$/, "");
  const match = identifier.match(/^(https?)_(.+)_([0-9]+)$/);
  if (!match) return undefined;
  const [, scheme, rawHost, rawPort] = match;
  const host = rawHost.includes(":") && !rawHost.startsWith("[")
    ? `[${rawHost}]`
    : rawHost;
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    return undefined;
  }
  return normalizeHttpOrigin(`${scheme}://${host}${port ? `:${port}` : ""}`);
}

async function levelDbStructureLooksValid(path: string) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error: any) {
    return error?.code === "ENOENT";
  }
  const names = new Set(entries.map((entry) => entry.name));
  const hasDatabaseFiles = entries.some(
    (entry) =>
      entry.isFile() &&
      (/^(?:MANIFEST-|CURRENT$)/.test(entry.name) ||
        /\.(?:log|ldb|sst)$/i.test(entry.name)),
  );
  if (!hasDatabaseFiles) return true;
  if (!names.has("CURRENT")) return false;
  try {
    const current = (await readFile(join(path, "CURRENT"), "utf8")).trim();
    return /^MANIFEST-[0-9]+$/.test(current) && names.has(current);
  } catch {
    return false;
  }
}

async function discoverLocalStorageOrigins(levelDbPath: string) {
  const origins = new Set<string>();
  let entries;
  try {
    entries = await readdir(levelDbPath, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return origins;
    throw error;
  }
  let bytesRead = 0;
  for (const entry of entries) {
    if (
      origins.size >= ORIGIN_LIMIT ||
      bytesRead >= LEVELDB_SCAN_BYTE_LIMIT ||
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !(/\.(?:log|ldb|sst)$/i.test(entry.name) || entry.name.startsWith("MANIFEST-"))
    ) {
      continue;
    }
    const path = join(levelDbPath, entry.name);
    let buffer: Buffer | undefined;
    try {
      const info = await lstat(path);
      const remaining = LEVELDB_SCAN_BYTE_LIMIT - bytesRead;
      if (!info.isFile() || info.size > remaining) continue;
      buffer = await readFile(path);
      bytesRead += buffer.length;
      const text = buffer.toString("latin1");
      const matches = text.matchAll(
        /META(?:ACCESS)?:((?:https?):\/\/[^\x00-\x20"'<>\\{}|^`]+)/g,
      );
      for (const match of matches) {
        const origin = normalizeHttpOrigin(match[1]);
        if (origin) origins.add(origin);
        if (origins.size >= ORIGIN_LIMIT) break;
      }
    } finally {
      buffer?.fill(0);
    }
  }
  return origins;
}

async function inspectQuotaDatabases(partitionPath: string) {
  const origins = new Set<string>();
  let found = false;
  for (const path of [
    join(partitionPath, "WebStorage", "QuotaManager"),
    join(partitionPath, "QuotaManager"),
  ]) {
    let database: DatabaseSync | undefined;
    try {
      const info = await stat(path);
      found = true;
      if (!info.isFile()) {
        return { compatible: false, origins: [] as string[] };
      }
      if (info.size > QUOTA_QUICK_CHECK_BYTE_LIMIT) continue;
      database = new DatabaseSync(path, { readOnly: true });
      const quickCheck = database.prepare("PRAGMA quick_check(1)").get() as
        | Record<string, unknown>
        | undefined;
      if (!quickCheck || !Object.values(quickCheck).includes("ok")) {
        return { compatible: false, origins: [] as string[] };
      }
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name?: unknown }>;
      for (const table of tables) {
        const name = String(table.name ?? "");
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        const columns = database
          .prepare(`PRAGMA table_info(${name})`)
          .all() as Array<{ name?: unknown }>;
        const originColumn = columns
          .map((column) => String(column.name ?? ""))
          .find((column) => column === "storage_key" || column === "origin");
        if (!originColumn) continue;
        const rows = database
          .prepare(`SELECT ${originColumn} AS origin FROM ${name} LIMIT ${ORIGIN_LIMIT}`)
          .all() as Array<{ origin?: unknown }>;
        for (const row of rows) {
          const origin = normalizeHttpOrigin(String(row.origin ?? ""));
          if (origin) origins.add(origin);
          if (origins.size >= ORIGIN_LIMIT) break;
        }
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      return { compatible: false, origins: [] as string[] };
    } finally {
      database?.close();
    }
  }
  return { compatible: true, origins: found ? [...origins] : [] };
}

function normalizeHttpOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
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
