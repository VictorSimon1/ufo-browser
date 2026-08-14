import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { NativeCefApplication } from "../dist/main/native-cef-application.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userData = await mkdtemp(join(tmpdir(), "ufo-native-restart-"));
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
await access(executable);
const env = {
  ...process.env,
  UFO_CEF_PRIVATE_BRIDGE: "1",
  UFO_CEF_USE_MOCK_KEYCHAIN: "1",
  UFO_BROWSER_NATIVE_USER_DATA: userData,
  UFO_BROWSER_SOURCE_PARTITIONS: join(userData, "NoSource"),
};
const app = new NativeCefApplication({ userDataDir: userData, cefExecutable: executable, useMockKeychain: true, env });
const cliPath = join(root, "dist/bin/ufo-browser");

try {
  await app.start({ startupTimeoutMs: 20_000 });
  const created = await runCli(cliPath, userData, `
const task = await bootstrapTaskSpace({ name: 'native restart restore', url: 'https://example.com/' })
cliLog(JSON.stringify({ id: task.id, page: await pageInfo() }))
`);
  const first = JSON.parse(created.trim().split("\n").at(-1));
  assert.match(first.page.title, /Example Domain/);
  await app.stop();

  await app.start({ startupTimeoutMs: 20_000 });
  const restored = await runCli(cliPath, userData, `
const spaces = await listTaskSpaces()
const task = spaces.find(space => space.id === ${Number(first.id)})
if (!task) throw new Error('restored Native Space missing')
await useTaskSpace(task.id)
cliLog(JSON.stringify({ spaces: spaces.length, restoredId: task.id, page: await pageInfo() }))
`);
  const second = JSON.parse(restored.trim().split("\n").at(-1));
  assert.equal(second.restoredId, first.id);
  assert.match(second.page.title, /Example Domain/);
  console.log(JSON.stringify({ persisted: true, restoredId: second.restoredId, title: second.page.title }));
} finally {
  await app.stop().catch(() => undefined);
}

async function runCli(cliPath, userData, script) {
  const socket = join(userData, "ufo-browser.sock");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { await access(socket); break; } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  await access(socket);
  const cli = spawn(cliPath, ["nodejs"], {
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
  cli.stdin.end(script);
  const code = await new Promise((resolveCode, rejectCode) => {
    cli.once("error", rejectCode);
    cli.once("exit", (value) => resolveCode(value ?? 1));
  });
  if (code !== 0) throw new Error(`Native restart CLI failed (${code})\n${stdout}\n${stderr}`);
  return stdout;
}
