import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { CHROME_STORAGE_PATHS } from "../chrome-import/storage-preflight.js";

type StorageRevisionRequest = {
  sourceRoot: string;
  targetRoot: string;
  datasets: string[];
};

if (!parentPort) throw new Error("Profile storage revision worker requires a parent port");

parentPort.once("message", async (request: StorageRevisionRequest) => {
  try {
    const allowed = new Set<string>(CHROME_STORAGE_PATHS);
    const datasets = [...new Set(request.datasets)].filter((dataset) =>
      allowed.has(dataset),
    );
    const result: Record<
      string,
      { sourceRevision: string | null; targetRevision: string | null }
    > = {};
    for (const dataset of datasets) {
      result[dataset] = {
        sourceRevision: await nodeRevision(join(request.sourceRoot, dataset)),
        targetRevision: await nodeRevision(join(request.targetRoot, dataset)),
      };
    }
    parentPort!.postMessage({ type: "result", result });
  } catch {
    parentPort!.postMessage({ type: "error", code: "storage-revision-failed" });
  }
});

async function nodeRevision(root: string): Promise<string | null> {
  let rootInfo;
  try {
    rootInfo = await lstat(root, { bigint: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    rootInfo.isSymbolicLink() ||
    quotaManagerSidecarFile(basename(root))
  ) {
    return null;
  }
  const records: string[] = [];
  await walk(root, root, records);
  records.sort();
  const hash = createHash("sha256");
  for (const record of records) hash.update(record).update("\n");
  return hash.digest("hex");
}

async function walk(root: string, path: string, records: string[]) {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink()) return;
  const name = path === root ? "." : relative(root, path);
  if (info.isDirectory()) {
    records.push(`d:${name}`);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || volatileStorageFile(entry.name)) continue;
      await walk(root, join(path, entry.name), records);
    }
    return;
  }
  if (info.isFile()) {
    const canonical = await canonicalQuotaManagerRevision(path);
    if (canonical) {
      records.push(`f:${name}:${canonical}`);
      return;
    }
    const content = createHash("sha256");
    for await (const chunk of createReadStream(path, {
      highWaterMark: 256 * 1024,
    })) {
      content.update(chunk as Buffer);
    }
    records.push(`f:${name}:${info.size}:${content.digest("hex")}`);
  }
}

async function canonicalQuotaManagerRevision(path: string) {
  if (basename(path) !== "QuotaManager") return undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    let database: DatabaseSync | undefined;
    try {
      // Read the live database through SQLite instead of cloning the database
      // and journal independently. Copying those files while Chromium is
      // committing can produce a torn snapshot, while SQLite gives us one
      // consistent read transaction and correctly includes WAL/journal state.
      database = new DatabaseSync(path, { readOnly: true });
      database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 750");
      return canonicalQuotaManagerDatabaseRevision(database);
    } catch (error) {
      lastError = error;
    } finally {
      database?.close();
    }
    try {
      // A force-terminated Chromium process can leave a valid hot rollback
      // journal. SQLite must write while recovering it, so a read-only open
      // fails even though the logical database is healthy. Recover only a
      // private copy; scanning must never mutate the user's Profile.
      return await canonicalQuotaManagerSnapshotRevision(path);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(20 * (attempt + 1));
    }
  }
  throw new Error("quota-manager-revision-unavailable", { cause: lastError });
}

async function canonicalQuotaManagerSnapshotRevision(path: string) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "ufo-profile-storage-revision-"),
  );
  const snapshot = join(temporaryRoot, "QuotaManager");
  let database: DatabaseSync | undefined;
  try {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const source = `${path}${suffix}`;
      try {
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const target = `${snapshot}${suffix}`;
        await copyFile(source, target, fsConstants.COPYFILE_FICLONE);
        await chmod(target, 0o600);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    database = new DatabaseSync(snapshot);
    database.exec("PRAGMA busy_timeout = 750");
    return canonicalQuotaManagerDatabaseRevision(database);
  } finally {
    database?.close();
    await rm(temporaryRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function canonicalQuotaManagerDatabaseRevision(database: DatabaseSync) {
  const table = database
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('buckets', 'meta') ORDER BY name",
    )
    .all();
  if (!table.some((entry: any) => entry.name === "buckets")) {
    throw new Error("quota-manager-schema-missing");
  }
  const columns = database
    .prepare("PRAGMA table_info(buckets)")
    .all()
    .map((entry: any) => String(entry.name || ""))
    .filter(
      (name) =>
        name &&
        name !== "id" &&
        name !== "use_count" &&
        name !== "last_accessed" &&
        name !== "last_modified",
    );
  const selected = columns
    .map(
      (column) =>
        `CAST("${column.replaceAll('"', '""')}" AS TEXT) AS "${column.replaceAll('"', '""')}"`,
    )
    .join(", ");
  const buckets = selected
    ? database
        .prepare(
          `SELECT ${selected} FROM buckets ORDER BY storage_key, name`,
        )
        .all()
        .filter((entry: any) => !runtimeDefaultBucket(entry))
    : [];
  const meta = table.some((entry: any) => entry.name === "meta")
    ? database
        .prepare(
          "SELECT CAST(key AS TEXT) AS key, CAST(value AS TEXT) AS value FROM meta WHERE key IN ('version', 'last_compatible_version') ORDER BY key",
        )
        .all()
    : [];
  return createHash("sha256")
    .update(JSON.stringify({ table, columns, buckets, meta }))
    .digest("hex");
}

function runtimeDefaultBucket(entry: any) {
  return (
    String(entry?.name ?? "") === "_default" &&
    zeroLike(entry?.expiration) &&
    zeroLike(entry?.quota) &&
    zeroLike(entry?.persistent) &&
    zeroLike(entry?.durability)
  );
}

function zeroLike(value: unknown) {
  return value == null || String(value) === "0";
}

function volatileStorageFile(name: string) {
  return (
    name === "LOCK" ||
    name === "LOG" ||
    name === "LOG.old" ||
    quotaManagerSidecarFile(name) ||
    name.endsWith(".tmp")
  );
}

function quotaManagerSidecarFile(name: string) {
  return (
    name === "QuotaManager-journal" ||
    name === "QuotaManager-wal" ||
    name === "QuotaManager-shm"
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
