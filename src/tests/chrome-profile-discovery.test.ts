import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromeTimeToUnixMilliseconds,
  detectChromeRunning,
  discoverChromeProfiles,
  estimateChromeImportBytes,
} from "../main/chrome-import/discovery.js";

test("Chrome discovery returns only safe Local State profiles and sanitized metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-chrome-discovery-"));
  try {
    await mkdir(join(root, "Default", "Local Storage"), { recursive: true });
    await mkdir(join(root, "Profile 2", "IndexedDB"), { recursive: true });
    await mkdir(join(root, "Guest Profile"), { recursive: true });
    await writeFile(join(root, "Default", "Cookies"), Buffer.alloc(17));
    await writeFile(join(root, "Default", "Local Storage", "000003.log"), Buffer.alloc(31));
    await writeFile(join(root, "Profile 2", "IndexedDB", "data"), Buffer.alloc(43));
    await writeFile(join(root, "Last Version"), "151.0.7922.108\n");
    await writeFile(
      join(root, "Local State"),
      JSON.stringify({
        profile: {
          last_used: "Profile 2",
          info_cache: {
            Default: {
              name: "Personal",
              user_name: "secret@example.com",
              active_time: "13413945600000000",
            },
            "Profile 2": { name: "Work" },
            "Guest Profile": { name: "Guest" },
            "../Escape": { name: "Escape" },
          },
        },
      }),
    );

    const profiles = await discoverChromeProfiles(root);
    assert.deepEqual(
      profiles.map((profile) => ({
        dir: profile.profileDirName,
        name: profile.displayName,
        isDefault: profile.isDefault,
        isLastUsed: profile.isLastUsed,
        bytes: profile.approximateImportBytes,
        version: profile.browserVersion,
      })),
      [
        {
          dir: "Default",
          name: "Personal",
          isDefault: true,
          isLastUsed: false,
          bytes: 48,
          version: "151.0.7922.108",
        },
        {
          dir: "Profile 2",
          name: "Work",
          isDefault: false,
          isLastUsed: true,
          bytes: 43,
          version: "151.0.7922.108",
        },
      ],
    );
    assert.equal(JSON.stringify(profiles).includes("secret@example.com"), false);
    assert.equal(profiles[0].activeAt, Date.UTC(2026, 0, 27));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome discovery rejects symlinked profile directories and malformed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-chrome-discovery-"));
  const outside = await mkdtemp(join(tmpdir(), "ufo-chrome-outside-"));
  try {
    await symlink(outside, join(root, "Default"));
    await writeFile(
      join(root, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Unsafe" } } } }),
    );
    assert.deepEqual(await discoverChromeProfiles(root), []);
    await writeFile(join(root, "Local State"), "not json");
    assert.deepEqual(await discoverChromeProfiles(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Chrome singleton lock detection never terminates the source process", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-chrome-discovery-"));
  try {
    assert.deepEqual(await detectChromeRunning(root), { running: false });
    await symlink(`test-host-${process.pid}`, join(root, "SingletonLock"));
    assert.deepEqual(await detectChromeRunning(root), {
      running: true,
      pid: process.pid,
      reason: "singleton-lock",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome timestamps convert from the 1601 microsecond epoch", () => {
  assert.equal(
    chromeTimeToUnixMilliseconds("11644473601000000"),
    1_000,
  );
  assert.equal(chromeTimeToUnixMilliseconds("invalid"), undefined);
});

test("Chrome import size estimation is bounded and prefers Network Cookies", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-chrome-discovery-"));
  const profilePath = join(root, "Default");
  try {
    await mkdir(join(profilePath, "Network"), { recursive: true });
    await mkdir(join(profilePath, "Local Storage"), { recursive: true });
    await writeFile(join(profilePath, "Cookies"), Buffer.alloc(100));
    await writeFile(join(profilePath, "Network", "Cookies"), Buffer.alloc(40));
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(
          join(profilePath, "Local Storage", `entry-${index}`),
          Buffer.alloc(10),
        ),
      ),
    );

    const complete = await estimateChromeImportBytes(profilePath, {
      budgetMs: 10_000,
      maxEntries: 1_000,
    });
    assert.equal(complete, 1_040);

    const bounded = await estimateChromeImportBytes(profilePath, {
      budgetMs: 10_000,
      maxEntries: 24,
    });
    assert.ok(bounded >= 40);
    assert.ok(bounded < complete);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
