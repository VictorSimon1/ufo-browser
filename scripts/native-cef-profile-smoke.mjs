import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { NativeCefApplication } from "../dist/main/native-cef-application.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const testRoot = await mkdtemp(join(tmpdir(), "ufo-native-profile-smoke-"));
const chromeRoot = join(testRoot, "Chrome");
const userData = join(testRoot, "UFO");
const secret = "ufo-native-profile-fixture-secret";
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
await access(executable);
await createChromeFixture(chromeRoot, secret);
const fixture = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Native Profile Session</title><p>profile session fixture</p>");
});
await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", resolveListen));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;

const createApp = () => new NativeCefApplication({
    userDataDir: userData,
    cefExecutable: executable,
    useMockKeychain: true,
    env: {
      UFO_CEF_PRIVATE_BRIDGE: "1",
      UFO_CEF_MOCK_KEYCHAIN_SECRET: secret,
      UFO_BROWSER_CHROME_USER_DATA: chromeRoot,
      UFO_BROWSER_SOURCE_PARTITIONS: join(userData, "NoSource"),
    },
  });
let app = createApp();

try {
  await app.start();
  const info = JSON.parse(await readFile(join(userData, "overview.json"), "utf8"));
  const discovered = await fetch(`${info.url}api/chrome/discover`).then((response) => response.json());
  assert.equal(discovered.running, false);
  assert.equal(discovered.profiles?.[0]?.profileDirName, "Default");

  let monitorRunning = true;
  let maxMainHostCount = 0;
  const hostMonitor = (async () => {
    while (monitorRunning) {
      const processes = await ps();
      const mainHosts = processes.filter((line) =>
        line === executable || line.startsWith(`${executable} `));
      maxMainHostCount = Math.max(maxMainHostCount, mainHosts.length);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  })();
  let imported;
  try {
    imported = await fetch(`${info.url}api/chrome/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileDirName: "Default", makeDefault: true, allowPartial: true }),
    }).then((response) => response.json());
  } finally {
    monitorRunning = false;
    await hostMonitor;
  }
  assert.equal(imported.status, "success", JSON.stringify(imported));
  assert.equal(imported.cookies.imported, 1, JSON.stringify(imported));
  assert.equal(maxMainHostCount, 1, `Profile import launched ${maxMainHostCount} UFO CEF main processes`);

  const profiles = await fetch(`${info.url}api/profiles`).then((response) => response.json());
  const importedProfile = profiles.profiles?.find((profile) => profile.source?.type === "chrome");
  assert.ok(importedProfile, "Native Overview did not publish the imported Chrome Profile");
  assert.equal(importedProfile.isDefault, true);
  const created = await fetch(`${info.url}api/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "native imported profile session",
      profileId: importedProfile.id,
    }),
  }).then((response) => response.json());
  assert.ok(created.space?.id, JSON.stringify(created));
  assert.equal(created.space.profileId, importedProfile.id);
  const spaceId = Number(created.space.id);
  const socket = join(userData, "ufo-browser.sock");
  const firstSession = await verifyImportedSession(socket, spaceId, fixtureUrl);
  assert.equal(firstSession.cookieAvailable, true, JSON.stringify(firstSession));

  // A persisted Native Chrome Profile must keep the imported login state
  // without repeating the source Cookie transaction on the next app launch.
  await app.stop();
  app = createApp();
  await app.start();
  const restartedSession = await verifyImportedSession(socket, spaceId, fixtureUrl);
  assert.equal(restartedSession.cookieAvailable, true, JSON.stringify(restartedSession));

  console.log(JSON.stringify({
    nativeProfileImport: true,
    importedCookies: imported.cookies.imported,
    selectedProfileAppliedToSpace: true,
    importedLoginStateSurvivesRestart: true,
    oneUfoMainProcessDuringProfileImport: true,
  }));
} finally {
  await app.stop().catch(() => undefined);
  await new Promise((resolveClose) => fixture.close(resolveClose));
  await rm(testRoot, { recursive: true, force: true });
}

async function verifyImportedSession(socket, spaceId, url) {
  const output = await runCli(socket, `
    await takeOverTaskSpace(${spaceId})
    await gotoAndWait(${JSON.stringify(url)})
    const cookieAvailable = await js("document.cookie.split(';').some((item) => item.trim().startsWith('native='))")
    await handOffTaskSpace(${spaceId})
    cliLog(JSON.stringify({ cookieAvailable }))
  `);
  return JSON.parse(output.trim().split("\n").at(-1));
}

function runCli(socket, source) {
  return new Promise((resolveOutput, reject) => {
    const cli = spawn(join(root, "dist/bin/ufo-browser"), ["nodejs"], {
      cwd: root,
      env: { ...process.env, UFO_BROWSER_SOCKET: socket },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    cli.stdout.setEncoding("utf8");
    cli.stderr.setEncoding("utf8");
    cli.stdout.on("data", (chunk) => { stdout += chunk; });
    cli.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => cli.kill("SIGTERM"), 30_000);
    cli.once("error", reject);
    cli.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveOutput(stdout);
      else reject(new Error(`Native Profile CLI failed (${code})\n${stdout}\n${stderr}`));
    });
    cli.stdin.end(source);
  });
}

function ps() {
  return new Promise((resolvePs, rejectPs) => {
    const child = spawn("/bin/ps", ["-axo", "command"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectPs);
    child.once("exit", (code) => code === 0
      ? resolvePs(output.split("\n"))
      : rejectPs(new Error(`ps failed (${code})`)));
  });
}

async function createChromeFixture(chromeRootPath, secretText) {
  const profilePath = join(chromeRootPath, "Default");
  await mkdir(profilePath, { recursive: true });
  await writeFile(join(chromeRootPath, "Last Version"), "151.0.0.0");
  await writeFile(join(chromeRootPath, "Local State"), JSON.stringify({
    profile: {
      last_used: "Default",
      info_cache: { Default: { name: "Native Fixture" } },
    },
  }));
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
  const key = pbkdf2Sync(Buffer.from(secretText), "saltysalt", 1003, 16, "sha1");
  const host = "127.0.0.1";
  const plaintext = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from("native-cookie")]);
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]);
  database.prepare(`
    INSERT INTO cookies(
      host_key, name, encrypted_value, is_secure, is_httponly,
      source_scheme, has_cross_site_ancestor, samesite
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(host, "native", encrypted, 0, 0, 1, 0, 1);
  database.close();
  key.fill(0);
  plaintext.fill(0);
  encrypted.fill(0);
}
