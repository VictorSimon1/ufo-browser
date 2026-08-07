import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  indexedDbDirectoryOrigin,
  inspectChromeStorageSnapshot,
  preflightChromeStorageSnapshot,
} from "../main/chrome-import/storage-preflight.js";
import { createChromeStoragePreflightWorker } from "../main/chrome-import/storage-preflight-worker.js";

test("Chrome storage preflight discovers origins without exposing stored values", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-storage-preflight-"));
  try {
    const localStorage = join(root, "Local Storage", "leveldb");
    const indexedDb = join(
      root,
      "IndexedDB",
      "https_accounts.example_0.indexeddb.leveldb",
    );
    await createLevelDb(localStorage, "META:https://accounts.example\0private-value");
    await createLevelDb(indexedDb, "indexed-private-value");
    await mkdir(join(root, "WebStorage"), { recursive: true });
    const quota = new DatabaseSync(join(root, "WebStorage", "QuotaManager"));
    quota.exec(`
      CREATE TABLE buckets(
        id INTEGER PRIMARY KEY,
        storage_key TEXT NOT NULL,
        host TEXT NOT NULL
      );
      INSERT INTO buckets(storage_key, host)
      VALUES ('https://files.example/', 'files.example');
    `);
    quota.close();

    const inspected = await inspectChromeStorageSnapshot(root, [
      "Local Storage",
      "IndexedDB",
      "WebStorage",
    ]);
    assert.deepEqual(inspected.failed, []);
    assert.deepEqual(inspected.warningCodes, []);
    assert.deepEqual(inspected.origins.localStorage, [
      "https://accounts.example",
    ]);
    assert.deepEqual(inspected.origins.indexedDb, [
      "https://accounts.example",
    ]);
    assert.deepEqual(inspected.origins.quota, ["https://files.example"]);
    assert.equal(JSON.stringify(inspected).includes("private-value"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome storage preflight prunes structurally invalid datasets", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-storage-preflight-"));
  try {
    const localStorage = join(root, "Local Storage", "leveldb");
    const indexedDb = join(
      root,
      "IndexedDB",
      "https_broken.example_0.indexeddb.leveldb",
    );
    await mkdir(localStorage, { recursive: true });
    await writeFile(join(localStorage, "CURRENT"), "MANIFEST-000009\n");
    await writeFile(join(localStorage, "000003.log"), "not-a-leveldb");
    await mkdir(indexedDb, { recursive: true });
    await writeFile(join(indexedDb, "000003.log"), "not-a-leveldb");
    await mkdir(join(root, "WebStorage"), { recursive: true });
    await writeFile(join(root, "WebStorage", "QuotaManager"), "not-sqlite");

    const result = await preflightChromeStorageSnapshot(root, [
      "Local Storage",
      "IndexedDB",
      "WebStorage",
    ]);
    assert.deepEqual(new Set(result.failed), new Set([
      "Local Storage",
      "IndexedDB",
      "WebStorage",
    ]));
    assert.deepEqual(new Set(result.warningCodes), new Set([
      "local-storage-incompatible",
      "indexeddb-incompatible",
      "storage-metadata-incompatible",
    ]));
    await assert.rejects(access(join(root, "Local Storage")));
    await assert.rejects(access(join(root, "IndexedDB")));
    await assert.rejects(access(join(root, "WebStorage")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("IndexedDB directory identifiers map only safe HTTP origins", () => {
  assert.equal(
    indexedDbDirectoryOrigin("http_127.0.0.1_8080.indexeddb.leveldb"),
    "http://127.0.0.1:8080",
  );
  assert.equal(
    indexedDbDirectoryOrigin("https_accounts.example_0.indexeddb.leveldb"),
    "https://accounts.example",
  );
  assert.equal(
    indexedDbDirectoryOrigin("chrome-extension_secret_0.indexeddb.leveldb"),
    undefined,
  );
});

test("static Chrome storage inspection stays off the main event loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-storage-worker-"));
  const partitionsRoot = join(root, "Partitions");
  const partitionId = "x-browser-profile-worker-fixture";
  const localStorage = join(
    partitionsRoot,
    partitionId,
    "Local Storage",
    "leveldb",
  );
  try {
    await createLevelDb(localStorage, "placeholder");
    const largeLog = Buffer.alloc(16 * 1024 * 1024);
    largeLog.write("META:https://worker.example\0private-value", 0, "latin1");
    await writeFile(join(localStorage, "000003.log"), largeLog);
    largeLog.fill(0);
    const preflight = createChromeStoragePreflightWorker(
      join(process.cwd(), "dist", "main", "chrome-storage-preflight-worker.js"),
      partitionsRoot,
    );
    let eventLoopTicks = 0;
    const timer = setInterval(() => eventLoopTicks++, 1);
    const result = await preflight("profile", partitionId, ["Local Storage"]);
    clearInterval(timer);

    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.warningCodes, []);
    assert.deepEqual(result.origins.localStorage, [
      "https://worker.example",
    ]);
    assert.ok(
      eventLoopTicks >= 1,
      `event loop did not advance during storage preflight (${eventLoopTicks})`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storage preflight Worker failures expose only a stable code", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-storage-worker-"));
  try {
    const missingWorkerPath = join(root, "private-worker-path.js");
    const preflight = createChromeStoragePreflightWorker(
      missingWorkerPath,
      join(root, "Partitions"),
    );
    await assert.rejects(
      preflight("profile", "partition", ["Local Storage"]),
      (error: Error) => {
        assert.equal(error.message, "storage-preflight-worker-failed");
        assert.equal(String(error).includes(missingWorkerPath), false);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createLevelDb(path: string, logContents: string) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "CURRENT"), "MANIFEST-000001\n");
  await writeFile(join(path, "MANIFEST-000001"), "manifest");
  await writeFile(join(path, "000003.log"), logContents);
}
