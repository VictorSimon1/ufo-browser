import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { request } from "node:http";

const root = resolve(new URL("..", import.meta.url).pathname);
const userData = await mkdtemp(join(tmpdir(), "ufo-native-agent-smoke-"));
const socket = join(userData, "agent.sock");
const executable = process.env.UFO_CEF_HOST || join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
await access(executable);
const agent = spawn(process.execPath, [join(root, "dist/main/native-cef-agent.js")], {
  cwd: root,
  env: { ...process.env, UFO_CEF_HOST: executable, UFO_BROWSER_NATIVE_USER_DATA: userData, UFO_BROWSER_SOURCE_PARTITIONS: join(userData, "NoSource"), UFO_BROWSER_SOCKET: socket, UFO_CEF_PORT_BASE: "9970", UFO_CEF_OVERVIEW_HTTP_PORT: "9973", UFO_CEF_OVERVIEW_PORT: "0", UFO_CEF_USE_MOCK_KEYCHAIN: "1", UFO_CEF_PRIVATE_BRIDGE: process.env.UFO_CEF_PRIVATE_BRIDGE || "1" },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
agent.stderr.setEncoding("utf8");
agent.stderr.on("data", (chunk) => { stderr += chunk; });
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  try { await access(socket); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
}
try { await access(socket); } catch { throw new Error(`Native CEF Agent socket did not start: ${stderr}`); }
const overviewResponse = await new Promise((resolve, reject) => {
  const req = request("http://127.0.0.1:9973/api/spaces", { method: "GET" }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.once("error", reject);
  req.end();
});
if (overviewResponse.status !== 200 || !String(overviewResponse.body).includes("spaces")) {
  throw new Error(`Native CEF Overview bridge failed: ${JSON.stringify(overviewResponse)}`);
}
const cli = spawn(join(root, "dist/bin/ufo-browser"), ["nodejs"], {
  cwd: root,
  env: { ...process.env, UFO_BROWSER_SOCKET: socket },
  stdio: ["pipe", "pipe", "pipe"],
});
const output = [];
let cliStderr = "";
cli.stdout.setEncoding("utf8");
cli.stdout.on("data", (chunk) => output.push(chunk));
cli.stderr.setEncoding("utf8");
cli.stderr.on("data", (chunk) => { cliStderr += chunk; });
cli.stdin.end(`const task = await bootstrapTaskSpace({ name: 'native cef smoke', url: 'https://example.com/' })\ncliLog(JSON.stringify(await pageInfo()))\ncliLog((await js('document.title')))\ncliLog((await snapshotText({ maxResultLength: 80 })).slice(0, 80))\ncliLog(await captureScreenshot())\nawait completeTaskSpace(task.id, { keep: false })\n`);
const code = await new Promise((resolveCode, reject) => { cli.once("error", reject); cli.once("exit", (value) => resolveCode(value ?? 1)); });
agent.kill("SIGTERM");
if (code !== 0) throw new Error(`Native CEF Agent CLI failed (${code})\n${output.join("")}\n${cliStderr}\n${stderr}`);
console.log(output.join(""));
