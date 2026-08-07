import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BrowserProfileRegistry } from "../main/profile-registry.js";
import { deriveChromeCookieKey } from "../main/chrome-import/cookies.js";
import { MockKeychainProvider } from "../main/chrome-import/keychain.js";
import {
  ChromeImportError,
  ChromeLoginImportService,
} from "../main/chrome-import/service.js";
import type { CookieWriteTarget } from "../main/chrome-import/cookie-writer.js";

test("Chrome import service commits verified Cookies and storage through a mock Keychain", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-import-service-"));
  const chromeRoot = join(root, "Chrome");
  const profilePath = join(chromeRoot, "Default");
  const userDataPath = join(root, "UFO");
  const secret = Buffer.from("mock-safe-storage");
  try {
    await createChromeFixture(chromeRoot, profilePath, secret);
    const registry = new BrowserProfileRegistry(join(userDataPath, "profiles.json"));
    await registry.initialize();
    const target = new FakeCookieTarget();
    const keychain = new MockKeychainProvider(secret);
    const service = new ChromeLoginImportService({
      userDataPath,
      partitionsRoot: join(userDataPath, "Partitions"),
      profiles: registry,
      keychain,
      targetChromiumVersion: "150.0.0.0",
      chromeUserDataPath: chromeRoot,
      createTarget: async () => target,
    });
    const discovered = await service.discover();
    assert.equal(discovered.running, false);
    assert.equal(discovered.profiles.length, 1);
    assert.equal("profilePath" in discovered.profiles[0], false);
    assert.equal("userDataPath" in discovered.profiles[0], false);

    const progress: string[] = [];
    const result = await service.importProfile("Default", true, true, (event) => {
      progress.push(event.phase);
    });
    assert.equal(result.status, "success");
    assert.equal(result.cookies.imported, 2);
    assert.equal(result.cookies.partitioned, 1);
    assert.equal(result.profile.isDefault, true);
    assert.deepEqual(progress, [
      "snapshotting",
      "importing-cookies",
      "verifying",
      "committed",
    ]);
    assert.equal(keychain.requests.length, 1);
    assert.equal(target.disposed, 1);
    assert.equal(JSON.stringify(result).includes("secret-cookie-value"), false);
    assert.equal(
      await readFile(
        join(
          userDataPath,
          "Partitions",
          registry.getDefault().partitionId,
          "Local Storage",
          "leveldb",
          "data",
        ),
        "utf8",
      ),
      "site-login-state",
    );
  } finally {
    secret.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome import refuses a running source before touching Keychain", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-import-service-"));
  const chromeRoot = join(root, "Chrome");
  const profilePath = join(chromeRoot, "Default");
  try {
    await createChromeFixture(chromeRoot, profilePath, Buffer.from("unused"));
    await symlink(`host-${process.pid}`, join(chromeRoot, "SingletonLock"));
    const keychain = new MockKeychainProvider("must-not-run");
    const registry = new BrowserProfileRegistry(join(root, "UFO", "profiles.json"));
    await registry.initialize();
    const service = new ChromeLoginImportService({
      userDataPath: join(root, "UFO"),
      partitionsRoot: join(root, "UFO", "Partitions"),
      profiles: registry,
      keychain,
      targetChromiumVersion: "150.0.0.0",
      chromeUserDataPath: chromeRoot,
      createTarget: async () => new FakeCookieTarget(),
    });
    await assert.rejects(
      service.importProfile("Default", true, true),
      (error: ChromeImportError) => error.code === "chrome-running",
    );
    assert.deepEqual(keychain.requests, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome import does not publish a Profile when every encrypted Cookie fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-import-service-"));
  const chromeRoot = join(root, "Chrome");
  const profilePath = join(chromeRoot, "Default");
  try {
    await createChromeFixture(chromeRoot, profilePath, Buffer.from("correct-secret"));
    const registry = new BrowserProfileRegistry(join(root, "UFO", "profiles.json"));
    await registry.initialize();
    const service = new ChromeLoginImportService({
      userDataPath: join(root, "UFO"),
      partitionsRoot: join(root, "UFO", "Partitions"),
      profiles: registry,
      keychain: new MockKeychainProvider("wrong-secret"),
      targetChromiumVersion: "150.0.0.0",
      chromeUserDataPath: chromeRoot,
      createTarget: async () => new FakeCookieTarget(),
    });
    await assert.rejects(
      service.importProfile("Default", true, true),
      (error: ChromeImportError) => error.code === "cookie-decryption-failed",
    );
    assert.equal(registry.listPublic().length, 1);
    assert.equal(registry.getDefault().id, "default");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome partial import requires explicit approval before publishing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-import-service-"));
  const chromeRoot = join(root, "Chrome");
  const profilePath = join(chromeRoot, "Default");
  try {
    await createChromeFixture(chromeRoot, profilePath, Buffer.from("unused"));
    await rm(join(profilePath, "Cookies"));
    await writeFile(join(chromeRoot, "Last Version"), "154.0.0.0");
    await mkdir(join(profilePath, "Service Worker"), { recursive: true });
    const userDataPath = join(root, "UFO");
    const registry = new BrowserProfileRegistry(join(userDataPath, "profiles.json"));
    await registry.initialize();
    const keychain = new MockKeychainProvider("must-not-run");
    const service = new ChromeLoginImportService({
      userDataPath,
      partitionsRoot: join(userDataPath, "Partitions"),
      profiles: registry,
      keychain,
      targetChromiumVersion: "150.0.0.0",
      chromeUserDataPath: chromeRoot,
      createTarget: async () => new FakeCookieTarget(),
    });

    await assert.rejects(
      service.importProfile("Default", false, false),
      (error: ChromeImportError) =>
        error.code === "partial-import-not-approved",
    );
    assert.equal(registry.listPublic().length, 1);
    assert.deepEqual(keychain.requests, []);

    const approved = await service.importProfile("Default", false, true);
    assert.equal(approved.status, "partial");
    assert.equal(approved.profile.isDefault, false);
    assert.deepEqual(approved.storage.warningCodes, [
      { code: "service-worker-version-mismatch", count: 1 },
    ]);
    assert.equal(registry.listPublic().length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class FakeCookieTarget implements CookieWriteTarget {
  regular: any[] = [];
  partitioned: any[] = [];
  disposed = 0;
  cookies = {
    set: async (details: any) => {
      this.regular.push({
        ...details,
        domain: details.domain ?? new URL(details.url).hostname,
        hostOnly: !details.domain,
        sameSite: details.sameSite,
      });
    },
    get: async () => this.regular,
  };
  cdp = {
    send: async (method: string, params?: any) => {
      if (method === "Network.setCookie") {
        this.partitioned.push({
          ...params,
          domain: params.domain ?? new URL(params.url).hostname,
        });
        return { success: true };
      }
      if (method === "Network.getAllCookies") return { cookies: this.partitioned };
      throw new Error("unexpected CDP method");
    },
  };
  flush() {}
  dispose() {
    this.disposed++;
  }
}

async function createChromeFixture(
  chromeRoot: string,
  profilePath: string,
  secret: Buffer,
) {
  await mkdir(join(profilePath, "Local Storage", "leveldb"), { recursive: true });
  await writeFile(join(profilePath, "Local Storage", "leveldb", "data"), "site-login-state");
  await writeFile(join(chromeRoot, "Last Version"), "151.0.0.0");
  await writeFile(
    join(chromeRoot, "Local State"),
    JSON.stringify({
      profile: {
        last_used: "Default",
        info_cache: { Default: { name: "Personal" } },
      },
    }),
  );
  const database = new DatabaseSync(join(profilePath, "Cookies"));
  database.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key, value) VALUES ('version', '24');
    CREATE TABLE cookies(
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      encrypted_value BLOB NOT NULL DEFAULT X'',
      path TEXT NOT NULL DEFAULT '/',
      expires_utc INTEGER NOT NULL DEFAULT 0,
      is_secure INTEGER NOT NULL DEFAULT 1,
      is_httponly INTEGER NOT NULL DEFAULT 1,
      has_expires INTEGER NOT NULL DEFAULT 0,
      is_persistent INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 1,
      samesite INTEGER NOT NULL DEFAULT 1,
      source_scheme INTEGER NOT NULL DEFAULT 2,
      source_port INTEGER NOT NULL DEFAULT 443,
      last_update_utc INTEGER NOT NULL DEFAULT 0,
      source_type INTEGER NOT NULL DEFAULT 1,
      has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
    );
  `);
  const key = deriveChromeCookieKey(secret);
  const insert = database.prepare(`
    INSERT INTO cookies(
      host_key, top_frame_site_key, name, encrypted_value,
      has_cross_site_ancestor
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const [host, top, name, crossSite] of [
    ["example.com", "", "regular", 0],
    ["partitioned.example", "https://top.example", "partitioned", 1],
  ] as const) {
    const plaintext = Buffer.concat([
      createHash("sha256").update(host).digest(),
      Buffer.from("secret-cookie-value"),
    ]);
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const encrypted = Buffer.concat([
      Buffer.from("v10"),
      cipher.update(plaintext),
      cipher.final(),
    ]);
    insert.run(host, top, name, encrypted, crossSite);
    plaintext.fill(0);
    encrypted.fill(0);
  }
  key.fill(0);
  database.close();
}
