import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const testNamespace = "temporary-profile";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
const electron = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const fixture = createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end("<!doctype html><meta charset=utf-8><title>Session isolation</title><main>Session isolation fixture</main>");
});
await new Promise((resolve, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", resolve);
});
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("fixture did not bind");
const origin = `http://127.0.0.1:${address.port}/`;
let child;
let stderr = "";

try {
  await stopTestApp();
  await rm(testRoot, { recursive: true, force: true });
  let launchedAt = Date.now();
  child = launch({
    X_BROWSER_TEST_TEMPORARY_PROFILE_AUDIT: "1",
    X_BROWSER_TEST_STORAGE_ORIGIN: origin,
  });
  const audit = await freshJson(
    "temporary-profile-audit.json",
    launchedAt,
    18_000,
  );
  assert.equal(audit.ok, true, JSON.stringify(audit));
  const cliOutput = await runProcess(
    join(root, "dist/bin/ufo-browser"),
    ["nodejs"],
    `const profiles = await listProfiles()
const task = await taskSpaces.new('CLI Temporary', { profileId: 'Temporary' })
cliLog(JSON.stringify({ profiles, task }))
`,
  );
  const cli = JSON.parse(cliOutput.split("\n").filter(Boolean).at(-1));
  assert.equal(
    cli.profiles.profiles.some(
      (profile) =>
        profile.id === "Temporary" && profile.name === "临时 Profile",
    ),
    true,
  );
  assert.equal(cli.task.profileId, "temporary");
  assert.equal(cli.task.profileMode, "temporary");

  await stopTestApp();
  child = undefined;
  launchedAt = Date.now();
  child = launch({
    X_BROWSER_TEST_TEMPORARY_PROFILE_RESTORE_AUDIT: "1",
  });
  const restore = await freshJson(
    "temporary-profile-restore-audit.json",
    launchedAt,
    12_000,
  );
  assert.equal(restore.ok, true, JSON.stringify(restore));
  process.stdout.write(`${JSON.stringify({ audit, cli, restore }, null, 2)}\n`);
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  child?.kill("SIGTERM");
  await stopTestApp().catch(() => undefined);
  await new Promise((resolve) => fixture.close(resolve));
}

function launch(extraEnv) {
  const processHandle = spawn(electron, ["."], {
    cwd: root,
    env: {
      ...process.env,
      X_BROWSER_TEST_APP: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  processHandle.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
  });
  return processHandle;
}

function runProcess(command, args, stdin = "") {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let processStderr = "";
    processHandle.stdout.on("data", (chunk) => (stdout += String(chunk)));
    processHandle.stderr.on(
      "data",
      (chunk) => (processStderr += String(chunk)),
    );
    processHandle.once("error", reject);
    processHandle.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${code}: ${processStderr || stdout}`));
    });
    processHandle.stdin.end(stdin);
  });
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
  throw new Error(`timed out waiting for ${name}: ${latestError || "not written"}`);
}
