import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const mode = process.argv[2] || "success";
if (!new Set(["success", "restart", "rollback"]).has(mode)) {
  throw new Error(`unsupported Chrome import verification mode: ${mode}`);
}
const testNamespace = `chrome-import-${mode}`;
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
const chromeRoot = join(testRoot, "chrome-fixture");
const safeStorageSecret = "ufo-fixture-safe-storage";
const forbiddenAuditValues = [
  safeStorageSecret,
  "fixture-cookie-value",
  "fixture-local-storage",
  "fixture-indexeddb",
  "fixture-opfs",
  "fixture-web-storage-copy",
  "fixture-file-system-copy",
  "fixture.example",
];
const configuredExecutable = process.env.X_BROWSER_TEST_EXECUTABLE;
const executable = configuredExecutable
  ? resolve(configuredExecutable)
  : join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
const executableArguments = configuredExecutable ? [] : ["."];
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");

let child;
let stderr = "";
let storageServer;
try {
  await stopTestApp();
  await rm(testRoot, { recursive: true, force: true });
  storageServer = await startStorageServer();
  await createChromeFixture(chromeRoot, safeStorageSecret);

  if (mode === "success") {
    const audit = await runPhase(
      "X_BROWSER_TEST_CHROME_IMPORT_UI_AUDIT",
      "chrome-import-ui-audit.json",
      safeStorageSecret,
    );
    assert.equal(audit.ok, true, JSON.stringify(audit));
    assert.equal(
      storageServer.preflightRequests,
      0,
      "Chrome storage preflight reached the fixture network server",
    );
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  } else if (mode === "restart") {
    const imported = await runPhase(
      "X_BROWSER_TEST_CHROME_IMPORT_UI_AUDIT",
      "chrome-import-ui-audit.json",
      safeStorageSecret,
    );
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.equal(
      storageServer.preflightRequests,
      0,
      "Chrome storage preflight reached the fixture network server",
    );
    await terminatePhase();
    const restarted = await runPhase(
      "X_BROWSER_TEST_CHROME_IMPORT_RESTART_AUDIT",
      "chrome-import-restart-audit.json",
      safeStorageSecret,
    );
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    process.stdout.write(`${JSON.stringify(restarted, null, 2)}\n`);
  } else {
    const failed = await runPhase(
      "X_BROWSER_TEST_CHROME_IMPORT_ROLLBACK_AUDIT",
      "chrome-import-rollback-audit.json",
      "wrong-fixture-secret",
    );
    assert.equal(failed.ok, true, JSON.stringify(failed));
    assert.equal(
      storageServer.preflightRequests,
      0,
      "Chrome storage preflight reached the fixture network server",
    );
    await terminatePhase();
    const recovered = await runPhase(
      "X_BROWSER_TEST_CHROME_IMPORT_ROLLBACK_RECOVERY_AUDIT",
      "chrome-import-rollback-recovery-audit.json",
      "wrong-fixture-secret",
    );
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    process.stdout.write(
      `${JSON.stringify({ failed, recovered }, null, 2)}\n`,
    );
  }
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  await terminatePhase().catch(() => undefined);
  await storageServer?.close().catch(() => undefined);
}

async function runPhase(auditFlag, auditName, secret) {
  const launchedAt = Date.now();
  stderr = "";
  child = spawn(executable, executableArguments, {
    cwd: root,
    env: {
      ...process.env,
      X_BROWSER_TEST_APP: "1",
      X_BROWSER_TEST_ROOT: testRoot,
      X_BROWSER_TEST_CHROME_USER_DATA_PATH: chromeRoot,
      X_BROWSER_TEST_CHROME_SAFE_STORAGE_SECRET: secret,
      X_BROWSER_TEST_CHROME_STORAGE_ORIGIN: storageServer.origin,
      [auditFlag]: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 30_000) stderr = stderr.slice(-30_000);
  });
  const audit = await freshJson(auditName, launchedAt, 20_000);
  const serialized = JSON.stringify(audit);
  for (const value of forbiddenAuditValues) {
    assert.equal(
      serialized.includes(value),
      false,
      `${auditName} exposed a fixture secret or storage value`,
    );
  }
  return audit;
}

async function terminatePhase() {
  child?.kill("SIGTERM");
  child = undefined;
  await stopTestApp();
}

async function stopTestApp() {
  return execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")]);
}

async function freshJson(name, launchedAt, timeoutMs) {
  const path = join(testRoot, name);
  const deadline = Date.now() + timeoutMs;
  let latestError;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs >= launchedAt - 250) {
        return JSON.parse(await readFile(path, "utf8"));
      }
    } catch (error) {
      latestError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(
    `timed out waiting for ${name}: ${latestError || "not written"}`,
  );
}

async function createChromeFixture(chromeRoot, secretText) {
  const profilePath = join(chromeRoot, "Default");
  await mkdir(profilePath, { recursive: true });
  await mkdir(join(profilePath, "WebStorage"), { recursive: true });
  await writeFile(
    join(profilePath, "WebStorage", "ufo-fixture-marker"),
    "fixture-web-storage-copy",
  );
  await mkdir(join(profilePath, "File System"), { recursive: true });
  await writeFile(
    join(profilePath, "File System", "ufo-fixture-marker"),
    "fixture-file-system-copy",
  );
  await writeFile(join(chromeRoot, "Last Version"), "151.0.0.0");
  await writeFile(
    join(chromeRoot, "Local State"),
    JSON.stringify({
      profile: {
        last_used: "Default",
        info_cache: {
          Default: {
            name: "Fixture Personal",
            active_time: "13420000000000000",
          },
        },
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
  const secret = Buffer.from(secretText);
  const key = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
  const insert = database.prepare(`
    INSERT INTO cookies(
      host_key, top_frame_site_key, name, encrypted_value,
      has_cross_site_ancestor, samesite
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const [host, top, name, crossSite, sameSite] of [
    ["fixture.example", "", "regular", 0, 1],
    ["chips.fixture.example", "https://fixture.example", "partitioned", 1, 0],
  ]) {
    const plaintext = Buffer.concat([
      createHash("sha256").update(host).digest(),
      Buffer.from("fixture-cookie-value"),
    ]);
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const encrypted = Buffer.concat([
      Buffer.from("v10"),
      cipher.update(plaintext),
      cipher.final(),
    ]);
    insert.run(host, top, name, encrypted, crossSite, sameSite);
    plaintext.fill(0);
    encrypted.fill(0);
  }
  secret.fill(0);
  key.fill(0);
  database.close();
}

async function startStorageServer() {
  let preflightRequests = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/.well-known/ufo-storage-preflight")) {
      preflightRequests++;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("<!doctype html><meta charset=utf-8><title>UFO import storage fixture</title>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Chrome import storage fixture server did not bind");
  }
  return {
    origin: `http://127.0.0.1:${address.port}/`,
    get preflightRequests() {
      return preflightRequests;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
