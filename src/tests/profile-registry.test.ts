import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserProfileRegistry,
  cleanupPendingProfilePartitions,
  DEFAULT_PROFILE_PARTITION_ID,
  isValidPartitionId,
  isValidProfileId,
} from "../main/profile-registry.js";

test("profile registry creates a private default profile atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-profile-registry-"));
  const path = join(root, "profiles.json");
  try {
    await chmod(root, 0o755);
    const registry = new BrowserProfileRegistry(path);
    await registry.initialize();
    assert.deepEqual(registry.listPublic(), [
      {
        id: "default",
        isDefault: true,
        name: "您的 UFO-Browser",
        kind: "local",
        source: undefined,
      },
    ]);
    assert.equal(registry.getDefault().partitionId, DEFAULT_PROFILE_PARTITION_ID);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile registry publishes an imported profile only after an atomic add", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-profile-registry-"));
  const path = join(root, "profiles.json");
  try {
    const registry = new BrowserProfileRegistry(path);
    await registry.initialize();
    const now = Date.now();
    await registry.add(
      {
        id: "chrome-default-abc123",
        partitionId: "x-browser-profile-chrome-default-abc123",
        name: "Chrome Default",
        kind: "imported",
        source: {
          browser: "chrome",
          profileDirName: "Default",
          displayName: "Chrome Default",
          importedAt: now,
          lastImportStatus: "success",
          loginSyncEnabled: false,
        },
        createdAt: now,
        updatedAt: now,
      },
      true,
    );
    assert.equal(registry.getDefault().id, "chrome-default-abc123");
    assert.equal(registry.listPublic()[0].isDefault, false);
    assert.equal(registry.listPublic()[1].isDefault, true);

    const reloaded = new BrowserProfileRegistry(path);
    await reloaded.initialize();
    assert.equal(reloaded.getDefault().partitionId, "x-browser-profile-chrome-default-abc123");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile registry keeps committed memory state on write failure and can retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-profile-registry-"));
  const path = join(root, "profiles.json");
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    const registry = new BrowserProfileRegistry(path);
    await registry.initialize();
    const profile = importedProfile("chrome-retry", "x-browser-profile-chrome-retry");
    await mkdir(temporaryPath);

    await assert.rejects(registry.add(profile, true));
    assert.equal(registry.listPublic().length, 1);
    assert.equal(registry.getDefault().id, "default");
    assert.equal(JSON.parse(await readFile(path, "utf8")).profiles.length, 1);

    await rm(temporaryPath, { recursive: true, force: true });
    await registry.add(profile, true);
    assert.equal(registry.listPublic().length, 2);
    assert.equal(registry.getDefault().id, profile.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removing an imported profile falls back to local and cleans its partition on cold start", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-profile-registry-"));
  const path = join(root, "profiles.json");
  const partitionsRoot = join(root, "Partitions");
  const partitionId = "x-browser-profile-chrome-removable";
  try {
    const registry = new BrowserProfileRegistry(path);
    await registry.initialize();
    const now = Date.now();
    await registry.add(
      {
        id: "chrome-removable",
        partitionId,
        name: "Chrome Personal",
        kind: "imported",
        source: {
          browser: "chrome",
          profileDirName: "Default",
          displayName: "Personal",
          importedAt: now,
          lastImportStatus: "success",
          loginSyncEnabled: false,
        },
        createdAt: now,
        updatedAt: now,
      },
      true,
    );
    await mkdir(join(partitionsRoot, partitionId), { recursive: true });
    await writeFile(join(partitionsRoot, partitionId, "Cookies"), "private state");

    await registry.remove("chrome-removable");
    assert.equal(registry.getDefault().id, "default");
    assert.deepEqual(registry.pendingPartitionCleanup(), [partitionId]);
    assert.equal(registry.listPublic().some((profile) => profile.id === "chrome-removable"), false);
    assert.equal(await readFile(join(partitionsRoot, partitionId, "Cookies"), "utf8"), "private state");

    const restarted = new BrowserProfileRegistry(path);
    await restarted.initialize();
    const pending = restarted.pendingPartitionCleanup();
    await cleanupPendingProfilePartitions(partitionsRoot, pending);
    await restarted.completePartitionCleanup(pending);
    await assert.rejects(readFile(join(partitionsRoot, partitionId, "Cookies"), "utf8"));
    assert.deepEqual(restarted.pendingPartitionCleanup(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the built-in local browser profile cannot be removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-profile-registry-"));
  try {
    const registry = new BrowserProfileRegistry(join(root, "profiles.json"));
    await registry.initialize();
    await assert.rejects(registry.remove("default"), /local browser profile cannot be removed/);
    assert.equal(registry.listPublic().length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile registry rejects traversal, duplicate partitions, and enabled sync", async () => {
  assert.equal(isValidProfileId("../Default"), false);
  assert.equal(isValidPartitionId("../../Chrome"), false);
  assert.equal(isValidPartitionId("x-browser-profile-safe_name"), true);

  const root = await mkdtemp(join(tmpdir(), "ufo-profile-registry-"));
  const path = join(root, "profiles.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        defaultProfileId: "imported",
        profiles: [
          {
            id: "imported",
            partitionId: "x-browser-profile-imported",
            name: "Imported",
            kind: "imported",
            source: {
              browser: "chrome",
              profileDirName: "Default",
              displayName: "Default",
              importedAt: Date.now(),
              lastImportStatus: "success",
              loginSyncEnabled: true,
            },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }),
    );
    await assert.rejects(
      new BrowserProfileRegistry(path).initialize(),
      /login sync is not available/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function importedProfile(id: string, partitionId: string) {
  const now = Date.now();
  return {
    id,
    partitionId,
    name: "Chrome Personal",
    kind: "imported" as const,
    source: {
      browser: "chrome" as const,
      profileDirName: "Default",
      displayName: "Personal",
      importedAt: now,
      lastImportStatus: "success" as const,
      loginSyncEnabled: false as const,
    },
    createdAt: now,
    updatedAt: now,
  };
}
