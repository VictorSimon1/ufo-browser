import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { NativeCefApplication } from "../dist/main/native-cef-application.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userDataDir = await mkdtemp(join(tmpdir(), "ufo-native-presentation-smoke-"));
const noSource = join(userDataDir, "NoSource");
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
await access(executable);
const app = new NativeCefApplication({
  userDataDir,
  cefExecutable: executable,
  useMockKeychain: true,
  env: { UFO_BROWSER_SOURCE_PARTITIONS: noSource },
});
if (!userDataDir.includes("ufo-native-presentation-smoke-")) {
  throw new Error(`Native presentation smoke must use an isolated data root: ${userDataDir}`);
}
let cli;
try {
  await app.start();
  const info = JSON.parse(await readFile(join(userDataDir, "overview.json"), "utf8"));
  const socket = join(userDataDir, "ufo-browser.sock");
  cli = spawn(join(root, "dist/bin/ufo-browser"), ["nodejs"], {
    cwd: root,
    env: { ...process.env, UFO_BROWSER_SOCKET: socket, UFO_BROWSER_SOURCE_PARTITIONS: noSource },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  cli.stdout.setEncoding("utf8");
  cli.stderr.setEncoding("utf8");
  cli.stdout.on("data", (chunk) => { stdout += chunk; });
  cli.stderr.on("data", (chunk) => { stderr += chunk; });
  cli.stdin.end("const task = await bootstrapTaskSpace({ name: 'native presentation smoke', url: 'https://example.com/' })\ncliLog(task.id)\n");
  const cliCode = await new Promise((resolveCode, reject) => {
    cli.once("error", reject);
    cli.once("exit", (code) => resolveCode(code ?? 1));
  });
  if (cliCode !== 0) throw new Error(`native CLI bootstrap failed (${cliCode})\n${stdout}\n${stderr}`);
  const spaceId = Number(stdout.trim().split(/\s+/).at(-1));
  if (!Number.isInteger(spaceId) || spaceId <= 0) throw new Error(`invalid Space id: ${stdout}`);
  const spacesUrl = `http://${info.host}:${info.port}/api/spaces`;
  const profilesResponse = await fetch(`http://${info.host}:${info.port}/api/profiles`).then((response) => response.json());
  if (!Array.isArray(profilesResponse.profiles) || profilesResponse.profiles.length === 0) {
    throw new Error(`Native Overview profiles failed: ${JSON.stringify(profilesResponse)}`);
  }
  const created = await fetch(spacesUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "native overview created", profileId: profilesResponse.profiles[0].id }),
  }).then((response) => response.json());
  if (!created.space?.id) throw new Error(`Native Overview create Space failed: ${JSON.stringify(created)}`);
  const createdSpaceId = Number(created.space.id);
  if (createdSpaceId === spaceId) throw new Error("Overview create endpoint reused an existing Space");
  const before = await fetch(spacesUrl).then((response) => response.json());
  if (!before.spaces?.some((space) => space.id === spaceId) || !before.spaces?.some((space) => space.id === createdSpaceId)) throw new Error("Space missing from Overview API");
  const preview = await fetch(`${spacesUrl}/${spaceId}/preview`).then((response) => response.json());
  if (!String(preview.dataUrl || "").startsWith("data:image/jpeg;base64,")) {
    throw new Error(`Native Overview preview failed: ${JSON.stringify(preview).slice(0, 500)}`);
  }
  const open = await fetch(`${spacesUrl}/${spaceId}/open`, { method: "POST" }).then((response) => response.json());
  if (!open.ok) throw new Error(`open Space failed: ${JSON.stringify(open)}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  const close = await fetch(`${spacesUrl}/${spaceId}/close`, { method: "POST" }).then((response) => response.json());
  if (!close.ok) throw new Error(`close Space failed: ${JSON.stringify(close)}`);
  const closeCreated = await fetch(`${spacesUrl}/${createdSpaceId}/close`, { method: "POST" }).then((response) => response.json());
  if (!closeCreated.ok) throw new Error(`close created Space failed: ${JSON.stringify(closeCreated)}`);
  console.log(JSON.stringify({ spaceId, createdSpaceId, overview: info.url, opened: true, closed: true }));
} finally {
  if (cli && cli.exitCode === null) cli.kill("SIGTERM");
  await app.stop();
}
