import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserProfileRegistry } from "../main/profile-registry.js";
import { NativeCefProfileSync } from "../main/native-cef-profile-sync.js";

test("Native CEF cold storage sync baselines, updates, and preserves target conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-native-storage-sync-"));
  const chromeRoot = join(root, "Chrome");
  const sourceRoot = join(chromeRoot, "Default");
  const targetRoot = join(root, "Native Space");
  const sourceFile = join(sourceRoot, "Local Storage", "state.bin");
  const targetFile = join(targetRoot, "Local Storage", "state.bin");
  await mkdir(join(sourceRoot, "Local Storage"), { recursive: true });
  await mkdir(join(targetRoot, "Local Storage"), { recursive: true });
  await writeFile(sourceFile, "source-v1");
  await writeFile(targetFile, "target-v1");

  const profiles = new BrowserProfileRegistry(join(root, "profiles.json"));
  await profiles.initialize();
  await profiles.add({
    id: "chrome-native-test",
    partitionId: "x-browser-profile-chrome-native-test",
    name: "Chrome Native Test",
    kind: "imported",
    source: {
      type: "chrome",
      browser: "chrome",
      profileDirName: "Default",
      displayName: "Default",
      importedAt: Date.now(),
      lastImportStatus: "success",
      loginSyncEnabled: true,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const manager = {
    getSpaceOrThrow: () => ({
      id: 1,
      profileId: "chrome-native-test",
      profileMode: "persistent",
    }),
  } as any;
  const sync = new NativeCefProfileSync({
    manager,
    profiles,
    sourcePartitionsRoot: join(root, "Partitions"),
    checkpointRoot: join(root, "Checkpoints"),
    keychainHelper: join(root, "unused-keychain-helper"),
    storageRevisionWorker: join(process.cwd(), "dist/main/profile-sync-storage-revision-worker.js"),
    storageWorkRoot: join(root, "Work"),
    chromeUserDataRoot: chromeRoot,
  });

  await sync.syncStorageBeforeRuntime(1, targetRoot);
  assert.equal(await readFile(targetFile, "utf8"), "target-v1", "baseline must not overwrite target");

  await writeFile(sourceFile, "source-v2");
  await sync.syncStorageBeforeRuntime(1, targetRoot);
  assert.equal(await readFile(targetFile, "utf8"), "source-v2", "source delta should update unchanged target");

  await writeFile(sourceFile, "source-v3");
  await writeFile(targetFile, "target-logout-or-local-change");
  await sync.syncStorageBeforeRuntime(1, targetRoot);
  assert.equal(
    await readFile(targetFile, "utf8"),
    "target-logout-or-local-change",
    "target divergence must win over source changes",
  );
  await sync.close();
});
