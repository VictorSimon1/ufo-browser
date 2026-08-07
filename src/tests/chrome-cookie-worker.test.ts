import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deriveChromeCookieKey } from "../main/chrome-import/cookies.js";
import { MockKeychainProvider } from "../main/chrome-import/keychain.js";
import { createChromeCookieWorkerReader } from "../main/chrome-import/worker-reader.js";

test("Chrome Cookie parsing stays off the main event loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-cookie-worker-"));
  const databasePath = join(root, "Cookies");
  const secret = Buffer.from("worker-safe-storage");
  try {
    createCookieFixture(databasePath, secret, 10_000);
    const keychain = new MockKeychainProvider(secret);
    const readCookies = createChromeCookieWorkerReader(
      join(process.cwd(), "dist", "main", "chrome-cookie-worker.js"),
      keychain,
    );
    let eventLoopTicks = 0;
    const timer = setInterval(() => eventLoopTicks++, 1);
    const result = await readCookies(databasePath);
    clearInterval(timer);

    assert.equal(result.cookies.length, 10_000);
    assert.equal(result.warnings.length, 0);
    assert.deepEqual(keychain.requests, ["Chrome Safe Storage"]);
    assert.ok(eventLoopTicks >= 5, `event loop advanced only ${eventLoopTicks} ticks`);
  } finally {
    secret.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

function createCookieFixture(
  databasePath: string,
  secret: Buffer,
  count: number,
) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key, value) VALUES ('version', '24');
    CREATE TABLE cookies(
      host_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      encrypted_value BLOB NOT NULL DEFAULT X'',
      path TEXT NOT NULL DEFAULT '/',
      expires_utc INTEGER NOT NULL DEFAULT 0,
      is_secure INTEGER NOT NULL DEFAULT 1,
      is_httponly INTEGER NOT NULL DEFAULT 1
    );
  `);
  const insert = database.prepare(`
    INSERT INTO cookies(host_key, name, encrypted_value)
    VALUES (?, ?, ?)
  `);
  const key = deriveChromeCookieKey(secret);
  const host = "worker.fixture.example";
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index++) {
      const plaintext = Buffer.concat([
        createHash("sha256").update(host).digest(),
        Buffer.from(`fixture-value-${index}`),
      ]);
      const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
      const encrypted = Buffer.concat([
        Buffer.from("v10"),
        cipher.update(plaintext),
        cipher.final(),
      ]);
      insert.run(host, `cookie-${index}`, encrypted);
      plaintext.fill(0);
      encrypted.fill(0);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    key.fill(0);
    database.close();
  }
}
