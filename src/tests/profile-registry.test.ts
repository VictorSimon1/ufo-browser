import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserProfileRegistry,
  DEFAULT_PROFILE_PARTITION_ID,
  isValidPartitionId,
  isValidProfileId,
} from "../main/profile-registry.js";

test("profile registry creates a private default profile atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-profile-registry-"));
  const path = join(root, "profiles.json");
  try {
    const registry = new BrowserProfileRegistry(path);
    await registry.initialize();
    assert.deepEqual(registry.listPublic(), [
      {
        id: "Default",
        isDefault: true,
        name: "您的 UFO-Browser",
        kind: "local",
        source: undefined,
      },
    ]);
    assert.equal(registry.getDefault().partitionId, DEFAULT_PROFILE_PARTITION_ID);
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
