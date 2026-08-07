import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserProfileRegistry } from "../main/profile-registry.js";
import type { DiscoveredChromeProfile } from "../main/chrome-import/discovery.js";
import {
  ChromeImportTransaction,
  recoverChromeImportJobs,
} from "../main/chrome-import/transaction.js";

test("Chrome import snapshots only login storage and publishes an isolated profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-import-transaction-"));
  const sourceRoot = join(root, "Chrome");
  const profilePath = join(sourceRoot, "Default");
  const jobsRoot = join(root, "UFO", "Chrome Import", "jobs");
  const partitionsRoot = join(root, "UFO", "Partitions");
  const registry = new BrowserProfileRegistry(join(root, "UFO", "profiles.json"));
  try {
    await registry.initialize();
    await mkdir(join(profilePath, "Local Storage", "leveldb"), { recursive: true });
    await mkdir(join(profilePath, "IndexedDB"), { recursive: true });
    await mkdir(join(profilePath, "Network"), { recursive: true });
    await mkdir(join(profilePath, "Service Worker", "CacheStorage"), {
      recursive: true,
    });
    await writeFile(join(profilePath, "Cookies"), "legacy-cookie-db");
    await writeFile(join(profilePath, "Network", "Cookies"), "encrypted-cookie-db");
    await writeFile(join(profilePath, "Local Storage", "leveldb", "data"), "local");
    await writeFile(join(profilePath, "IndexedDB", "data"), "indexed");
    await writeFile(join(profilePath, "Service Worker", "CacheStorage", "data"), "sw");
    await writeFile(join(profilePath, "History"), "must-not-copy");
    await symlink(join(profilePath, "History"), join(profilePath, "Local Storage", "escape"));

    const transaction = await ChromeImportTransaction.create({
      jobsRoot,
      partitionsRoot,
      source: sourceProfile(sourceRoot, profilePath),
      targetChromiumVersion: "150.0.0.0",
      id: "11111111-2222-3333-4444-555555555555",
      now: () => 1234,
    });
    const snapshot = await transaction.snapshot();
    assert.equal(snapshot.phase, "preparing-profile");
    assert.deepEqual(snapshot.compatibility, {
      sourceChromiumVersion: "151.0.0.0",
      targetChromiumVersion: "150.0.0.0",
    });
    assert.equal(snapshot.storage.cookieDatabasePresent, true);
    assert.deepEqual(snapshot.storage.copied, [
      "Local Storage",
      "IndexedDB",
      "Service Worker",
    ]);
    assert.equal(await readFile(transaction.stagedCookieDatabasePath, "utf8"), "encrypted-cookie-db");
    await assert.rejects(access(join(transaction.stagedPartitionPath, "History")));
    await assert.rejects(
      access(join(transaction.stagedPartitionPath, "Local Storage", "escape")),
    );

    await transaction.activateStorage();
    await transaction.setPhase("importing-cookies");
    await transaction.setPhase("verifying");
    const profile = await transaction.publish(registry, "success", true);
    assert.equal(registry.getDefault().id, profile.id);
    assert.equal(registry.getDefault().partitionId, profile.partitionId);
    assert.equal(
      await readFile(join(partitionsRoot, profile.partitionId, "IndexedDB", "data"), "utf8"),
      "indexed",
    );
    await assert.rejects(access(transaction.jobRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed and abandoned import jobs recover without deleting published profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-import-transaction-"));
  const sourceRoot = join(root, "Chrome");
  const profilePath = join(sourceRoot, "Default");
  const jobsRoot = join(root, "UFO", "Chrome Import", "jobs");
  const partitionsRoot = join(root, "UFO", "Partitions");
  try {
    await mkdir(profilePath, { recursive: true });
    const abandoned = await ChromeImportTransaction.create({
      jobsRoot,
      partitionsRoot,
      source: sourceProfile(sourceRoot, profilePath),
      targetChromiumVersion: "150.0.0.0",
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    await abandoned.snapshot();
    await abandoned.activateStorage();
    await abandoned.fail(
      "Cookie value authorization=do-not-persist must never be persisted",
      true,
    );
    const abandonedManifest = JSON.parse(
      await readFile(join(abandoned.jobRoot, "job.json"), "utf8"),
    );
    assert.equal(abandonedManifest.failureCode, "chrome-import-failed");
    assert.doesNotMatch(
      JSON.stringify(abandonedManifest),
      /authorization|do-not-persist/i,
    );
    assert.equal(abandonedManifest.phase, "cleanup-pending");

    const published = await ChromeImportTransaction.create({
      jobsRoot,
      partitionsRoot,
      source: sourceProfile(sourceRoot, profilePath),
      targetChromiumVersion: "150.0.0.0",
      id: "ffffffff-1111-2222-3333-444444444444",
    });
    await published.snapshot();
    await published.activateStorage();
    await published.setPhase("publishing");

    const result = await recoverChromeImportJobs(
      jobsRoot,
      partitionsRoot,
      new Set([published.state().target.partitionId]),
    );
    assert.deepEqual(result, { recovered: 1, preserved: 1 });
    await assert.rejects(access(abandoned.targetPartitionPath));
    await access(published.targetPartitionPath);
    await assert.rejects(access(abandoned.jobRoot));
    await assert.rejects(access(published.jobRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("newer Chrome Service Worker data is skipped instead of risking corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-import-transaction-"));
  const sourceRoot = join(root, "Chrome");
  const profilePath = join(sourceRoot, "Default");
  try {
    await mkdir(join(profilePath, "Service Worker"), { recursive: true });
    await writeFile(join(profilePath, "Service Worker", "data"), "newer");
    const transaction = await ChromeImportTransaction.create({
      jobsRoot: join(root, "jobs"),
      partitionsRoot: join(root, "partitions"),
      source: { ...sourceProfile(sourceRoot, profilePath), browserVersion: "154.0.0.0" },
      targetChromiumVersion: "150.0.0.0",
    });
    const snapshot = await transaction.snapshot();
    assert.equal(snapshot.storage.copied.includes("Service Worker"), false);
    assert.equal(snapshot.storage.skipped.includes("Service Worker"), true);
    assert.deepEqual(snapshot.storage.warningCodes, [
      "service-worker-version-mismatch",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional Service Worker copy failures become partial warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-import-transaction-"));
  const sourceRoot = join(root, "Chrome");
  const profilePath = join(sourceRoot, "Default");
  try {
    await mkdir(join(profilePath, "Service Worker"), { recursive: true });
    await writeFile(join(profilePath, "Service Worker", "data"), "optional");
    const transaction = await ChromeImportTransaction.create({
      jobsRoot: join(root, "jobs"),
      partitionsRoot: join(root, "partitions"),
      source: sourceProfile(sourceRoot, profilePath),
      targetChromiumVersion: "150.0.0.0",
      copyStorageTree: async (sourcePath) => {
        if (sourcePath.endsWith("Service Worker")) {
          throw new Error("fixture optional copy failure");
        }
      },
    });
    const snapshot = await transaction.snapshot();
    assert.equal(snapshot.phase, "preparing-profile");
    assert.equal(snapshot.storage.copied.includes("Service Worker"), false);
    assert.equal(snapshot.storage.skipped.includes("Service Worker"), true);
    assert.deepEqual(snapshot.storage.warningCodes, [
      "service-worker-copy-failed",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome import job ids and source profile paths cannot traverse", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-import-transaction-"));
  const sourceRoot = join(root, "Chrome");
  const outside = join(root, "outside");
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await assert.rejects(
      ChromeImportTransaction.create({
        jobsRoot: join(root, "jobs"),
        partitionsRoot: join(root, "partitions"),
        source: sourceProfile(sourceRoot, outside),
        targetChromiumVersion: "150.0.0.0",
        id: "../escape",
      }),
      /invalid Chrome import job id/,
    );
    await symlink(outside, join(sourceRoot, "Default"));
    const transaction = await ChromeImportTransaction.create({
      jobsRoot: join(root, "jobs"),
      partitionsRoot: join(root, "partitions"),
      source: sourceProfile(sourceRoot, join(sourceRoot, "Default")),
      targetChromiumVersion: "150.0.0.0",
    });
    await assert.rejects(transaction.snapshot(), /safe directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sourceProfile(
  userDataPath: string,
  profilePath: string,
): DiscoveredChromeProfile {
  return {
    browser: "chrome",
    browserName: "Google Chrome",
    browserVersion: "151.0.0.0",
    userDataPath,
    profilePath,
    profileDirName: "Default",
    displayName: "Personal",
    isDefault: true,
    isLastUsed: true,
    approximateImportBytes: 0,
  };
}
