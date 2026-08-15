import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const userData = await mkdtemp(join(tmpdir(), "ufo-native-parity-"));
const noSource = join(userData, "NoSource");
const socket = join(userData, "agent.sock");
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
await access(executable);

let port;
const fixture = createServer((request, response) => {
  if (request.url === "/child") {
    response.end("<!doctype html><title>Frame Child</title><button id=frame-action>Frame action</button>");
    return;
  }
  if (request.url === "/popup") {
    response.end("<!doctype html><title>Popup Child</title><button>Popup action</button>");
    return;
  }
  if (request.url === "/download") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": "attachment; filename=agent-native-download.txt",
    });
    response.end("agent native download\n");
    return;
  }
  response.end(`<!doctype html><title>Parity Main</title>
    <button id=open onclick="window.open('/popup','named-popup')">Open popup</button>
    <a id=download href="/download">Download</a>
    <iframe title="cross-origin child" src="http://localhost:${port}/child"></iframe>`);
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
    UFO_BROWSER_SOURCE_PARTITIONS: noSource,
    UFO_BROWSER_SOCKET: socket,
    UFO_CEF_USE_MOCK_KEYCHAIN: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
console.error("[native parity] agent starting");
let agentStderr = "";
agent.stderr.setEncoding("utf8");
agent.stderr.on("data", (chunk) => { agentStderr += chunk; });
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  try { await access(socket); break; } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); }
}
await access(socket);
console.error("[native parity] agent ready");

const cli = spawn(join(root, "dist/bin/ufo-browser"), ["nodejs"], {
  cwd: root,
  env: { ...process.env, UFO_BROWSER_SOCKET: socket },
  stdio: ["pipe", "pipe", "pipe"],
});
const cliTimeout = setTimeout(() => cli.kill("SIGTERM"), 30_000);
let stdout = "";
let stderr = "";
cli.stdout.setEncoding("utf8");
cli.stderr.setEncoding("utf8");
cli.stdout.on("data", (chunk) => { stdout += chunk; });
cli.stderr.on("data", (chunk) => { stderr += chunk; });
cli.stdin.end(`
const task = await bootstrapTaskSpace({ name: 'native parity' })
cliLog('step:bootstrapped')
await openOrReuseTab('http://127.0.0.1:${port}/main', { wait: true, timeout: 20000 })
cliLog('step:navigated')
const snapshot = await snapshotRaw({ includeActionMarks: true })
cliLog('step:snapshot')
const before = await listTabs()
const popupEval = await js("void window.open('http://127.0.0.1:${port}/popup', 'native-agent-popup'); true")
cliLog('step:popup-opened')
const popupTargets = await cdp('Target.getTargets')
const pendingDownload = page.waitForEvent('download', { timeout: 10000 })
await click('#download', { label: 'download fixture' })
cliLog('step:download-clicked')
const download = await pendingDownload
const downloadPath = await download.path()
cliLog('step:download-finished')
const popupDeadline = Date.now() + 10000
let after = []
while (Date.now() < popupDeadline) {
  after = await listTabs()
  if (after.some((tab) => !before.some((item) => item.targetId === tab.targetId))) break
  await new Promise((resolve) => setTimeout(resolve, 100))
}
cliLog(JSON.stringify({ snapshot, before, after, popupEval, popupTargets,
  download: { suggestedFilename: download.suggestedFilename(), url: download.url(), path: downloadPath } }))
`);
const code = await new Promise((resolveCode, rejectCode) => {
  cli.once("error", rejectCode);
  cli.once("exit", (value) => resolveCode(value ?? 1));
});
clearTimeout(cliTimeout);
console.error(`[native parity] cli exited ${code}`);
if (code !== 0) throw new Error(`Native parity CLI failed (${code})\n${stdout}\n${stderr}\n${agentStderr}`);
const result = JSON.parse(stdout.trim().split("\n").at(-1));
assert.match(result.snapshot.content, /iframe/);
assert.match(result.snapshot.content, /Frame action/);
assert.ok(result.snapshot.refs.some((ref) => ref.frameId), "iframe refs must preserve frameId");
assert.ok(result.after.some((tab) => !result.before.some((item) => item.targetId === tab.targetId)),
  `popup target was not exposed through listTabs: ${JSON.stringify(result.after)}`);
assert.equal(result.download.suggestedFilename, "agent-native-download.txt");
assert.equal(result.download.url, `http://127.0.0.1:${port}/download`);
assert.equal(await readFile(result.download.path, "utf8"), "agent native download\n");
console.log(JSON.stringify({
  snapshotHasIframe: true,
  iframeRef: result.snapshot.refs.find((ref) => ref.frameId)?.frameId,
  popupVisible: true,
  download: { suggestedFilename: result.download.suggestedFilename, url: result.download.url },
}));
agent.kill("SIGTERM");
fixture.close();
