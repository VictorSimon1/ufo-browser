import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const userData = await mkdtemp(join(tmpdir(), "ufo-native-agent-events-"));
const socket = join(userData, "agent.sock");
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
await access(executable);
let port;
const fixture = createServer((request, response) => {
  response.end(`<!doctype html><title>Agent Events</title><script>
    console.log('agent-event-console');
    setTimeout(() => fetch('/agent-event-fetch'), 100);
    setTimeout(() => { throw new Error('agent-event-pageerror'); }, 250);
  </script>`);
});
await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", () => {
  port = fixture.address().port;
  resolveListen();
}));
const agent = spawn(process.execPath, [join(root, "dist/main/native-cef-agent.js")], {
  cwd: root,
  env: {
    ...process.env,
    UFO_CEF_HOST: executable,
    UFO_CEF_PRIVATE_BRIDGE: "1",
    UFO_BROWSER_NATIVE_USER_DATA: userData,
    UFO_BROWSER_SOURCE_PARTITIONS: join(userData, "NoSource"),
    UFO_BROWSER_SOCKET: socket,
    UFO_CEF_USE_MOCK_KEYCHAIN: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let agentStderr = "";
agent.stderr.setEncoding("utf8");
agent.stderr.on("data", (chunk) => { agentStderr += chunk; });
try {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { await access(socket); break; } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
  }
  await access(socket);
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
  cli.stdin.end(`
const task = await bootstrapTaskSpace({ name: 'native agent events' })
await openOrReuseTab('http://127.0.0.1:${port}/', { wait: true, timeout: 20000 })
const seen = { console: false, pageerror: false, request: false }
page.on('console', event => { if (event.text().includes('agent-event-console')) seen.console = true })
page.on('pageerror', error => { if (String(error.message).includes('agent-event-pageerror')) seen.pageerror = true })
page.on('request', request => { if (request.url().endsWith('/agent-event-fetch')) seen.request = true })
await waitForTimeout(1000)
cliLog(JSON.stringify(seen))
`);
  const code = await new Promise((resolveCode, rejectCode) => {
    cli.once("error", rejectCode);
    cli.once("exit", (value) => resolveCode(value ?? 1));
  });
  if (code !== 0) throw new Error(`Native Agent event CLI failed (${code})\n${stdout}\n${stderr}\n${agentStderr}`);
  const seen = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.deepEqual(seen, { console: true, pageerror: true, request: true });
  console.log(JSON.stringify(seen));
} finally {
  agent.kill("SIGTERM");
  fixture.close();
}
