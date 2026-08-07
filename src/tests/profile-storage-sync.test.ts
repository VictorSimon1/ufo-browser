import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CookieWriteTarget } from "../main/chrome-import/cookie-writer.js";
import { BrowserProfileRegistry } from "../main/profile-registry.js";
import { ProfileSyncCheckpointStore } from "../main/profile-sync/checkpoint-store.js";
import type {
  ProfileCookieSourceProvider,
  ProfileCookieSourceSnapshot,
} from "../main/profile-sync/source-providers.js";
import { UfoProfileCookieSourceProvider } from "../main/profile-sync/source-providers.js";
import { replaceProfileStorageDataset } from "../main/profile-sync/storage-copy.js";
import { createStorageRevisionWorker } from "../main/profile-sync/storage-revision-worker-reader.js";
import { ProfileStorageSyncService } from "../main/profile-sync/storage-sync.js";

const REVISION_WORKER_PATH = new URL(
  "../main/profile-sync-storage-revision-worker.js",
  import.meta.url,
).pathname;

test("Profile storage sync baselines, updates source deltas, and preserves UFO conflicts", async () => {
  const fixture = await createStorageFixture();
  try {
    const baseline = await fixture.createService().prepareProfile("chrome-clone");
    assert.equal(baseline.result, "baselined");
    assert.equal(await fixture.readTarget(), "ufo-v1");

    const touchedAt = new Date(Date.now() + 2_000);
    await utimes(
      join(fixture.targetDataset, "state.bin"),
      touchedAt,
      touchedAt,
    );
    await fixture.writeSource("source-v2-expanded");
    const updated = await fixture.createService().prepareProfile("chrome-clone");
    assert.equal(updated.result, "updated");
    assert.equal(updated.changed, 1);
    assert.equal(await fixture.readTarget(), "source-v2-expanded");

    await fixture.writeTarget("ufo-logout");
    await fixture.writeSource("source-v3-expanded-again");
    const conflict = await fixture.createService().prepareProfile("chrome-clone");
    assert.equal(conflict.result, "conflict");
    assert.equal(conflict.conflicts, 1);
    assert.equal(await fixture.readTarget(), "ufo-logout");
  } finally {
    await fixture.close();
  }
});

test("re-enabling storage sync establishes a fresh non-destructive baseline", async () => {
  const fixture = await createStorageFixture("source-v1", "ufo-v1");
  try {
    await fixture.createService().seedProfile("chrome-clone");
    await fixture.writeSource("source-while-disabled");
    await fixture.writeTarget("ufo-while-disabled");

    const rebaselined = await fixture
      .createService()
      .rebaselineProfile("chrome-clone");
    assert.equal(rebaselined.result, "baselined");
    assert.equal(await fixture.readTarget(), "ufo-while-disabled");

    await fixture.writeSource("source-after-enable");
    const updated = await fixture.createService().prepareProfile("chrome-clone");
    assert.equal(updated.result, "updated");
    assert.equal(await fixture.readTarget(), "source-after-enable");
  } finally {
    await fixture.close();
  }
});

test("Profile storage sync propagates source deletion only without UFO divergence", async () => {
  const fixture = await createStorageFixture("same", "same");
  try {
    await fixture.createService().prepareProfile("chrome-clone");
    await fixture.writeSource("source-v2");
    await fixture.createService().prepareProfile("chrome-clone");
    await rm(fixture.sourceDataset, { recursive: true, force: true });

    const removed = await fixture.createService().prepareProfile("chrome-clone");
    assert.equal(removed.result, "updated");
    await assert.rejects(access(fixture.targetDataset), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});

test("Profile storage sync skips a non-quiescent source without touching UFO", async () => {
  const fixture = await createStorageFixture("source", "ufo", false);
  try {
    const result = await fixture.createService().prepareProfile("chrome-clone");
    assert.equal(result.result, "skipped");
    assert.equal(await fixture.readTarget(), "ufo");
  } finally {
    await fixture.close();
  }
});

test("Profile storage replacement restores its backup when publication fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-storage-rollback-"));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const sourceDataset = join(sourceRoot, "Local Storage");
  const targetDataset = join(targetRoot, "Local Storage");
  try {
    await mkdir(sourceDataset, { recursive: true });
    await mkdir(targetDataset, { recursive: true });
    await writeFile(join(sourceDataset, "state.bin"), "source-new");
    await writeFile(join(targetDataset, "state.bin"), "ufo-before");

    await assert.rejects(
      replaceProfileStorageDataset({
        sourceRoot,
        targetRoot,
        workRoot: join(root, "work"),
        dataset: "Local Storage",
        sourcePresent: true,
        beforePublish: () => {
          throw new Error("injected-publication-failure");
        },
      }),
      /injected-publication-failure/,
    );
    assert.equal(
      await readFile(join(targetDataset, "state.bin"), "utf8"),
      "ufo-before",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("10,000 storage files are revised off the main event loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-storage-revision-"));
  const sourceDataset = join(root, "source", "Local Storage");
  const targetRoot = join(root, "target");
  try {
    await mkdir(sourceDataset, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    for (let offset = 0; offset < 10_000; offset += 128) {
      await Promise.all(
        Array.from({ length: Math.min(128, 10_000 - offset) }, (_, index) =>
          writeFile(
            join(sourceDataset, `entry-${offset + index}.bin`),
            String(offset + index),
          ),
        ),
      );
    }
    const heartbeat = eventLoopHeartbeat(2);
    const revisions = await createStorageRevisionWorker(REVISION_WORKER_PATH)(
      join(root, "source"),
      targetRoot,
      ["Local Storage"],
    );
    const responsiveness = heartbeat.stop();
    assert.match(revisions["Local Storage"].sourceRevision || "", /^[a-f0-9]{64}$/);
    assert.ok(responsiveness.ticks >= 2, JSON.stringify(responsiveness));
    assert.ok(responsiveness.maxStallMs < 50, JSON.stringify(responsiveness));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QuotaManager runtime counters and journals do not create false storage conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-quota-revision-"));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const webStorage = join(targetRoot, "WebStorage");
  const quotaPath = join(webStorage, "QuotaManager");
  let database: DatabaseSync | undefined;
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(webStorage, { recursive: true });
    await writeFile(join(webStorage, "marker"), "stable");
    database = new DatabaseSync(quotaPath);
    database.exec(`
      CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      INSERT INTO meta(key, value) VALUES ('version', '11');
      CREATE TABLE buckets(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storage_key TEXT NOT NULL,
        host TEXT NOT NULL,
        name TEXT NOT NULL,
        use_count INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL,
        last_modified INTEGER NOT NULL,
        expiration INTEGER NOT NULL,
        quota INTEGER NOT NULL,
        persistent INTEGER NOT NULL,
        durability INTEGER NOT NULL
      ) STRICT;
    `);
    const scan = createStorageRevisionWorker(REVISION_WORKER_PATH);
    const baseline = await scan(sourceRoot, targetRoot, [
      "WebStorage",
      "QuotaManager-journal",
    ]);

    database.exec(`
      INSERT INTO buckets(
        storage_key, host, name, use_count, last_accessed, last_modified,
        expiration, quota, persistent, durability
      ) VALUES ('https://example.test/', 'example.test', '_default', 1,
        13430609141023807, 13430609141023807, 0, 0, 0, 0);
      UPDATE buckets
      SET use_count = use_count + 1,
          last_accessed = last_accessed + 100,
          last_modified = last_modified + 100;
    `);
    await writeFile(join(webStorage, "QuotaManager-journal"), "");
    const runtimeOnly = await scan(sourceRoot, targetRoot, [
      "WebStorage",
      "QuotaManager-journal",
    ]);
    assert.equal(
      runtimeOnly.WebStorage.targetRevision,
      baseline.WebStorage.targetRevision,
    );
    assert.equal(runtimeOnly["QuotaManager-journal"].targetRevision, null);

    database.exec("UPDATE buckets SET quota = quota + 1");
    const semanticChange = await scan(sourceRoot, targetRoot, ["WebStorage"]);
    assert.notEqual(
      semanticChange.WebStorage.targetRevision,
      baseline.WebStorage.targetRevision,
    );

    database.exec("BEGIN IMMEDIATE; UPDATE buckets SET use_count = use_count + 1");
    const whileWriting = await scan(sourceRoot, targetRoot, ["WebStorage"]);
    assert.equal(
      whileWriting.WebStorage.targetRevision,
      semanticChange.WebStorage.targetRevision,
    );
    database.exec("ROLLBACK");
  } finally {
    try {
      database?.exec("ROLLBACK");
    } catch {
      // No active transaction.
    }
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("UFO storage providers follow the direct clone source and flush it first", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-storage-source-chain-"));
  const registry = new BrowserProfileRegistry(join(root, "profiles.json"));
  await registry.initialize();
  const now = Date.now();
  await registry.add({
    id: "clone-a",
    partitionId: "x-browser-profile-clone-a",
    name: "Clone A",
    kind: "imported",
    source: {
      type: "ufo",
      browser: "ufo-browser",
      profileId: "default",
      displayName: "Default",
      importedAt: now,
      lastImportStatus: "success",
      loginSyncEnabled: true,
    },
    createdAt: now,
    updatedAt: now,
  });
  await registry.add({
    id: "clone-b",
    partitionId: "x-browser-profile-clone-b",
    name: "Clone B",
    kind: "imported",
    source: {
      type: "ufo",
      browser: "ufo-browser",
      profileId: "clone-a",
      displayName: "Clone A",
      importedAt: now + 1,
      lastImportStatus: "success",
      loginSyncEnabled: true,
    },
    createdAt: now + 1,
    updatedAt: now + 1,
  });
  const target = new FlushTarget();
  const prepared: string[] = [];
  try {
    const provider = new UfoProfileCookieSourceProvider(
      (profileId) => registry.getOrThrow(profileId),
      async () => target,
      join(root, "Partitions"),
      async (profileId) => {
        prepared.push(profileId);
      },
    );
    const source = await provider.storageSource(registry.getOrThrow("clone-b"));
    assert.equal(
      source.root,
      join(root, "Partitions", "x-browser-profile-clone-a"),
    );
    assert.deepEqual(prepared, ["clone-a"]);
    assert.equal(target.flushes, 1);
    assert.equal(target.disposals, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createStorageFixture(
  sourceValue = "source-v1",
  targetValue = "ufo-v1",
  quiescent = true,
) {
  const root = await mkdtemp(join(tmpdir(), "ufo-profile-storage-sync-"));
  const partitionsRoot = join(root, "Partitions");
  const sourceRoot = join(root, "chrome", "Default");
  const sourceDataset = join(sourceRoot, "Local Storage");
  const targetRoot = join(partitionsRoot, "x-browser-profile-chrome-clone");
  const targetDataset = join(targetRoot, "Local Storage");
  await mkdir(sourceDataset, { recursive: true });
  await mkdir(targetDataset, { recursive: true });
  await writeFile(join(sourceDataset, "state.bin"), sourceValue);
  await writeFile(join(targetDataset, "state.bin"), targetValue);

  const registry = new BrowserProfileRegistry(join(root, "profiles.json"));
  await registry.initialize();
  const now = Date.now();
  await registry.add({
    id: "chrome-clone",
    partitionId: "x-browser-profile-chrome-clone",
    name: "Chrome Clone",
    kind: "imported",
    source: {
      type: "chrome",
      browser: "chrome",
      profileDirName: "Default",
      displayName: "Default",
      importedAt: now,
      lastImportStatus: "success",
      loginSyncEnabled: true,
    },
    createdAt: now,
    updatedAt: now,
  });
  const checkpoints = new ProfileSyncCheckpointStore(join(root, "checkpoints"));
  const provider = new StorageSourceProvider(sourceRoot, quiescent);
  return {
    root,
    sourceDataset,
    targetDataset,
    createService: () =>
      new ProfileStorageSyncService({
        profiles: registry,
        checkpoints,
        sourceProviders: [provider],
        partitionsRoot,
        workRoot: join(root, "work"),
        scanRevisions: createStorageRevisionWorker(REVISION_WORKER_PATH),
      }),
    writeSource: (value: string) =>
      writeFile(join(sourceDataset, "state.bin"), value),
    writeTarget: (value: string) =>
      writeFile(join(targetDataset, "state.bin"), value),
    readTarget: () => readFile(join(targetDataset, "state.bin"), "utf8"),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

class StorageSourceProvider implements ProfileCookieSourceProvider {
  constructor(
    private readonly root: string,
    private readonly quiescent: boolean,
  ) {}

  supports(source: any) {
    return source?.type === "chrome";
  }

  async snapshot(): Promise<ProfileCookieSourceSnapshot> {
    return { unchanged: true, revision: "a".repeat(64) };
  }

  async storageSource() {
    return { root: this.root, quiescent: this.quiescent };
  }
}

class FlushTarget implements CookieWriteTarget {
  flushes = 0;
  disposals = 0;

  cookies = {
    async get() {
      return [] as Electron.Cookie[];
    },
    async set(_details: Electron.CookiesSetDetails) {},
    async remove(_url: string, _name: string) {},
  };

  cdp = {
    async send(method: string) {
      if (method === "Network.getAllCookies") return { cookies: [] };
      return {};
    },
  };

  async flush() {
    this.flushes++;
  }

  async dispose() {
    this.disposals++;
  }
}

function eventLoopHeartbeat(intervalMs: number) {
  let ticks = 0;
  let maxGapMs = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - previous);
    previous = now;
    ticks++;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return {
        ticks,
        maxGapMs,
        maxStallMs: Math.max(0, maxGapMs - intervalMs),
      };
    },
  };
}
