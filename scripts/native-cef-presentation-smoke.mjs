import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { NativeCefApplication } from "../dist/main/native-cef-application.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userDataDir = await mkdtemp(join(tmpdir(), "ufo-native-presentation-smoke-"));
const noSource = join(userDataDir, "NoSource");
// macOS limits AF_UNIX paths to roughly 104 bytes. `tmpdir()` expands to a
// long /var/folders path, so keep the control socket itself under /tmp.
const controlSocket = `/tmp/ufo-pres-${process.pid}-${Date.now()}.sock`;
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
await access(executable);
const app = new NativeCefApplication({
  userDataDir,
  cefExecutable: executable,
  useMockKeychain: true,
  env: {
    UFO_BROWSER_SOURCE_PARTITIONS: noSource,
    UFO_CEF_PRIVATE_BRIDGE: "1",
    UFO_BROWSER_OVERVIEW_CONTROL_SOCKET: controlSocket,
  },
});
if (!userDataDir.includes("ufo-native-presentation-smoke-")) {
  throw new Error(`Native presentation smoke must use an isolated data root: ${userDataDir}`);
}
let cli;
try {
  await app.start();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  const initialPresentation = await presentationStatus(controlSocket);
  if (!initialPresentation.overviewPresented || initialPresentation.presentedWindowCount !== 1) {
    throw new Error(`Overview must be the only presented Native window: ${JSON.stringify(initialPresentation)}`);
  }
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
  const spacePresentation = await presentationStatus(controlSocket);
  if (spacePresentation.overviewPresented ||
      spacePresentation.presentedWindowCount !== 1 ||
      spacePresentation.visibleSpaceId !== spaceId ||
      !spacePresentation.presentedSpaceIds?.includes(spaceId)) {
    throw new Error(`Space must be the only presented Native window: ${JSON.stringify(spacePresentation)}`);
  }
  const close = await fetch(`${spacesUrl}/${spaceId}/close`, { method: "POST" }).then((response) => response.json());
  if (!close.ok) throw new Error(`close Space failed: ${JSON.stringify(close)}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  const returnedPresentation = await presentationStatus(controlSocket);
  if (!returnedPresentation.overviewPresented ||
      returnedPresentation.presentedWindowCount !== 1 ||
      returnedPresentation.visibleSpaceId !== 0) {
    throw new Error(`Closing the visible Space must return to one Overview window: ${JSON.stringify(returnedPresentation)}`);
  }
  const closeCreated = await fetch(`${spacesUrl}/${createdSpaceId}/close`, { method: "POST" }).then((response) => response.json());
  if (!closeCreated.ok) throw new Error(`close created Space failed: ${JSON.stringify(closeCreated)}`);
  console.log(JSON.stringify({
    spaceId,
    createdSpaceId,
    overview: info.url,
    opened: true,
    closed: true,
    onePresentedWindow: true,
  }));
} finally {
  if (cli && cli.exitCode === null) cli.kill("SIGTERM");
  await app.stop();
  await rm(controlSocket, { force: true }).catch(() => undefined);
}

function presentationStatus(path) {
  return new Promise((resolveStatus, reject) => {
    const socket = createConnection(path);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", reject);
    socket.once("close", () => {
      try { resolveStatus(JSON.parse(response.trim())); }
      catch (error) { reject(error); }
    });
    socket.once("connect", () => socket.end(`${JSON.stringify({ command: "presentation-status" })}\n`));
  });
}
