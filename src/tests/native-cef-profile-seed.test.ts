import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seedNativeCefProfile } from "../main/native-cef-profile-seed.js";

test("native CEF profile seed copies login storage once and skips locks/symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-cef-seed-"));
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(join(source, "Local Storage", "leveldb"), { recursive: true });
    await writeFile(join(source, "Local Storage", "leveldb", "000001.ldb"), "login");
    await writeFile(join(source, "SingletonLock"), "lock");
    await writeFile(join(source, "Local State"), "foreign-root-metadata");
    await writeFile(join(source, "Preferences"), "prefs");
    await symlink("/tmp", join(source, "symlinked"));
    assert.deepEqual(
      await seedNativeCefProfile({ sourceRoot: source, targetRoot: target, sourceProfileId: "default" }),
      { seeded: true, reason: "copied" },
    );
    assert.equal(await readFile(join(target, "Preferences"), "utf8"), "prefs");
    assert.equal(await readFile(join(target, "Local Storage", "leveldb", "000001.ldb"), "utf8"), "login");
    await assert.rejects(() => readFile(join(target, "Local State")), /ENOENT/);
    await assert.rejects(() => readFile(join(target, "SingletonLock")), /ENOENT/);
    assert.deepEqual(
      await seedNativeCefProfile({ sourceRoot: source, targetRoot: target, sourceProfileId: "default" }),
      { seeded: false, reason: "already-seeded" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
