import test from "node:test";
import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  chromeTimeToUnixSeconds,
  deriveChromeCookieKey,
  readChromeCookies,
} from "../main/chrome-import/cookies.js";
import {
  CHROME_SAFE_STORAGE_SERVICE,
  MockKeychainProvider,
} from "../main/chrome-import/keychain.js";

const CHROME_EPOCH_OFFSET = 11_644_473_600_000_000n;

test("Chrome Cookie import decrypts v24 values and preserves CHIPS attributes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-cookie-import-"));
  const path = join(root, "Cookies");
  const secret = "test safe storage";
  const key = deriveChromeCookieKey(Buffer.from(secret));
  const nowSeconds = 1_800_000_000;
  try {
    const database = createCookieDatabase(path, 24);
    insertCookie(database, {
      host_key: ".example.com",
      top_frame_site_key: "https://top.example",
      name: "session",
      encrypted_value: encryptCookie(
        key,
        Buffer.concat([
          createHash("sha256").update(".example.com").digest(),
          Buffer.from("secret-value"),
        ]),
      ),
      expires_utc: "0",
      has_expires: 0,
      is_persistent: 0,
      is_secure: 1,
      is_httponly: 1,
      samesite: 0,
      priority: 2,
      source_scheme: 2,
      source_port: 443,
      source_type: 2,
      has_cross_site_ancestor: 1,
    });
    insertCookie(database, {
      host_key: "plain.example",
      name: "plain",
      value: "plain-value",
      expires_utc: unixToChromeTime(nowSeconds + 120),
      has_expires: 1,
      is_persistent: 1,
      samesite: 1,
      priority: 1,
      source_scheme: 1,
    });
    database.close();

    const keychain = new MockKeychainProvider(secret);
    const result = await readChromeCookies(path, keychain, nowSeconds);
    assert.equal(result.databaseVersion, 24);
    assert.deepEqual(result.warnings, []);
    assert.equal(keychain.requests.length, 1);
    assert.equal(keychain.requests[0], CHROME_SAFE_STORAGE_SERVICE);
    assert.deepEqual(result.cookies[0], {
      domain: ".example.com",
      hostOnly: false,
      name: "session",
      value: "secret-value",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
      expirationDate: nowSeconds + 30 * 24 * 60 * 60,
      wasSessionCookie: true,
      priority: "High",
      sourceScheme: "Secure",
      sourcePort: 443,
      sourceType: 2,
      lastUpdateChromeTime: "0",
      partitionKey: {
        topLevelSite: "https://top.example",
        hasCrossSiteAncestor: true,
      },
    });
    assert.equal(result.cookies[1].value, "plain-value");
    assert.equal(result.cookies[1].sameSite, "lax");
    assert.equal(result.cookies[1].expirationDate, nowSeconds + 120);
  } finally {
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("Cookie import reports wrong keys, host digests, expired rows, and prefixes without secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-cookie-import-"));
  const path = join(root, "Cookies");
  const rightKey = deriveChromeCookieKey(Buffer.from("right"));
  try {
    const database = createCookieDatabase(path, 24);
    insertCookie(database, {
      host_key: "wrong-key.example",
      name: "wrong-key",
      encrypted_value: encryptCookie(rightKey, Buffer.alloc(32, 1)),
    });
    insertCookie(database, {
      host_key: "unsupported.example",
      name: "unsupported",
      encrypted_value: Buffer.from("v20not-supported"),
    });
    insertCookie(database, {
      host_key: "expired.example",
      name: "expired",
      value: "do-not-log-this",
      expires_utc: unixToChromeTime(100),
      has_expires: 1,
      is_persistent: 1,
    });
    database.close();

    const result = await readChromeCookies(
      path,
      new MockKeychainProvider("wrong"),
      1_000,
    );
    assert.deepEqual(result.cookies, []);
    assert.deepEqual(
      result.warnings.sort((a, b) => a.code.localeCompare(b.code)),
      [
        { code: "decryption-failed", count: 1 },
        { code: "expired-cookie", count: 1 },
        { code: "unsupported-encryption", count: 1 },
      ],
    );
    assert.equal(JSON.stringify(result).includes("do-not-log-this"), false);
  } finally {
    rightKey.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("Cookie import rejects a valid decryption with the wrong v24 host digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-cookie-import-"));
  const path = join(root, "Cookies");
  const secret = Buffer.from("secret");
  const key = deriveChromeCookieKey(secret);
  try {
    const database = createCookieDatabase(path, 24);
    insertCookie(database, {
      host_key: "actual.example",
      name: "digest",
      encrypted_value: encryptCookie(
        key,
        Buffer.concat([
          createHash("sha256").update("other.example").digest(),
          Buffer.from("value"),
        ]),
      ),
    });
    database.close();
    const result = await readChromeCookies(
      path,
      new MockKeychainProvider(secret),
      1_000,
    );
    assert.deepEqual(result.warnings, [
      { code: "host-digest-mismatch", count: 1 },
    ]);
  } finally {
    secret.fill(0);
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-v24 v11 Cookies decrypt without a host digest and allow an empty name", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-cookie-import-"));
  const path = join(root, "Cookies");
  const secret = Buffer.from("legacy-secret");
  const key = deriveChromeCookieKey(secret);
  try {
    const database = createCookieDatabase(path, 23);
    insertCookie(database, {
      host_key: "legacy.example",
      name: "",
      encrypted_value: encryptCookie(key, Buffer.from("legacy-value"), "v11"),
    });
    database.close();
    const result = await readChromeCookies(
      path,
      new MockKeychainProvider(secret),
      1_000,
    );
    assert.equal(result.cookies[0].name, "");
    assert.equal(result.cookies[0].value, "legacy-value");
    assert.deepEqual(result.warnings, []);
  } finally {
    secret.fill(0);
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome timestamps preserve exact seconds outside JavaScript integer microsecond range", () => {
  assert.equal(
    chromeTimeToUnixSeconds("11644473642000000"),
    42,
  );
});

function createCookieDatabase(path: string, version: number) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key, value) VALUES ('version', '${version}');
    CREATE TABLE cookies(
      creation_utc INTEGER NOT NULL DEFAULT 0,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      encrypted_value BLOB NOT NULL DEFAULT X'',
      path TEXT NOT NULL DEFAULT '/',
      expires_utc INTEGER NOT NULL DEFAULT 0,
      is_secure INTEGER NOT NULL DEFAULT 0,
      is_httponly INTEGER NOT NULL DEFAULT 0,
      last_access_utc INTEGER NOT NULL DEFAULT 0,
      has_expires INTEGER NOT NULL DEFAULT 0,
      is_persistent INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 1,
      samesite INTEGER NOT NULL DEFAULT -1,
      source_scheme INTEGER NOT NULL DEFAULT 0,
      source_port INTEGER NOT NULL DEFAULT -1,
      last_update_utc INTEGER NOT NULL DEFAULT 0,
      source_type INTEGER NOT NULL DEFAULT 0,
      has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
    );
  `);
  return database;
}

function insertCookie(database: DatabaseSync, values: Record<string, unknown>) {
  const row = {
    host_key: "example.com",
    top_frame_site_key: "",
    name: "cookie",
    value: "",
    encrypted_value: Buffer.alloc(0),
    path: "/",
    expires_utc: "0",
    is_secure: 0,
    is_httponly: 0,
    has_expires: 0,
    is_persistent: 0,
    priority: 1,
    samesite: -1,
    source_scheme: 0,
    source_port: -1,
    last_update_utc: "0",
    source_type: 0,
    has_cross_site_ancestor: 0,
    ...values,
  };
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(",");
  database
    .prepare(`INSERT INTO cookies(${columns.join(",")}) VALUES (${placeholders})`)
    .run(...Object.values(row));
}

function encryptCookie(key: Buffer, plaintext: Buffer, prefix = "v10") {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([
    Buffer.from(prefix),
    cipher.update(plaintext),
    cipher.final(),
  ]);
}

function unixToChromeTime(unixSeconds: number) {
  return String(CHROME_EPOCH_OFFSET + BigInt(unixSeconds) * 1_000_000n);
}
