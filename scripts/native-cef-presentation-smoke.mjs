import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { NativeCefApplication } from "../dist/main/native-cef-application.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const nativeProductShell = process.env.UFO_BROWSER_NATIVE_CHROME_PRODUCT_SHELL !== "0";
const userDataDir = await mkdtemp(join(tmpdir(), "ufo-native-presentation-smoke-"));
const noSource = join(userDataDir, "NoSource");
// macOS limits AF_UNIX paths to roughly 104 bytes. `tmpdir()` expands to a
// long /var/folders path, so keep the control socket itself under /tmp.
const controlSocket = `/tmp/ufo-pres-${process.pid}-${Date.now()}.sock`;
const presentationSocket = `/tmp/ufo-shell-${process.pid}-${Date.now()}.sock`;
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
    UFO_BROWSER_PRESENTATION_SOCKET: presentationSocket,
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
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  const afterBackgroundBootstrap = await presentationStatus(controlSocket);
  if (!afterBackgroundBootstrap.overviewPresented ||
      afterBackgroundBootstrap.presentedWindowCount !== 1 ||
      afterBackgroundBootstrap.visibleSpaceId !== 0 ||
      afterBackgroundBootstrap.presentedSpaceIds?.includes(spaceId) ||
      !afterBackgroundBootstrap.awakeSpaceIds?.includes(spaceId)) {
    throw new Error(`Background Agent bootstrap must stay inside the hidden shared Host surface: ${JSON.stringify(afterBackgroundBootstrap)}`);
  }
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
      !spacePresentation.presentedSpaceIds?.includes(spaceId) ||
      !hasSpaceControls(spacePresentation, spaceId)) {
    throw new Error(`Space must be the only presented Native window: ${JSON.stringify(spacePresentation)}`);
  }
  const openCreated = await fetch(`${spacesUrl}/${createdSpaceId}/open`, { method: "POST" }).then((response) => response.json());
  if (!openCreated.ok) throw new Error(`open created Space failed: ${JSON.stringify(openCreated)}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  const createdPresentation = await presentationStatus(controlSocket);
  if (createdPresentation.visibleSpaceId !== createdSpaceId ||
      !hasSpaceControls(createdPresentation, createdSpaceId)) {
    throw new Error(`Chrome controls did not follow the second warm Space: ${JSON.stringify(createdPresentation)}`);
  }
  const reopen = await fetch(`${spacesUrl}/${spaceId}/open`, { method: "POST" }).then((response) => response.json());
  if (!reopen.ok) throw new Error(`reopen Space failed: ${JSON.stringify(reopen)}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  const reopenedPresentation = await presentationStatus(controlSocket);
  if (reopenedPresentation.visibleSpaceId !== spaceId ||
      !hasSpaceControls(reopenedPresentation, spaceId) ||
      !reopenedPresentation.awakeSpaceIds?.includes(spaceId) ||
      !reopenedPresentation.sleepingSpaceIds?.includes(createdSpaceId)) {
    throw new Error(`Chrome controls did not return to the first warm Space: ${JSON.stringify(reopenedPresentation)}`);
  }
  const showOverview = await sendSocket(presentationSocket, "show-overview");
  if (showOverview !== "ok") throw new Error(`show Overview failed: ${showOverview}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const overviewBeforePreview = await presentationStatus(controlSocket);
  if (!overviewBeforePreview.overviewPresented ||
      overviewBeforePreview.visibleSpaceId !== 0 ||
      !overviewBeforePreview.sleepingSpaceIds?.includes(createdSpaceId)) {
    throw new Error(`Overview did not preserve the sleeping background Space: ${JSON.stringify(overviewBeforePreview)}`);
  }
  const backgroundPreview = await fetch(`${spacesUrl}/${createdSpaceId}/preview`).then((response) => response.json());
  if (!String(backgroundPreview.dataUrl || "").startsWith("data:image/jpeg;base64,")) {
    throw new Error(`Sleeping Space did not wake for preview capture: ${JSON.stringify(backgroundPreview).slice(0, 500)}`);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
  const afterPreviewSleep = await presentationStatus(controlSocket);
  if (!afterPreviewSleep.sleepingSpaceIds?.includes(createdSpaceId) ||
      !afterPreviewSleep.awakeSpaceIds?.includes(spaceId)) {
    throw new Error(`Background compositor did not return to sleep: ${JSON.stringify(afterPreviewSleep)}`);
  }
  const reopenAgentSpace = await fetch(`${spacesUrl}/${spaceId}/open`, { method: "POST" }).then((response) => response.json());
  if (!reopenAgentSpace.ok) throw new Error(`reopen Agent Space failed: ${JSON.stringify(reopenAgentSpace)}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  // A native red-button close is blocked while the Agent still owns the
  // Space, even though titlebar dragging remains available.
  const blockedClose = await sendSocket(controlSocket, JSON.stringify({
    command: "request-window-close-space",
    spaceId,
  }));
  if (blockedClose !== "ok") throw new Error(`native close request failed: ${blockedClose}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  const afterBlockedClose = await fetch(spacesUrl).then((response) => response.json());
  if (!afterBlockedClose.spaces?.some((space) => space.id === spaceId)) {
    throw new Error("Agent-owned Space was closed through the native titlebar");
  }
  const showUserSpace = await fetch(`${spacesUrl}/${createdSpaceId}/open`, { method: "POST" }).then((response) => response.json());
  if (!showUserSpace.ok) throw new Error(`open user Space failed: ${JSON.stringify(showUserSpace)}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const closeBackground = await fetch(`${spacesUrl}/${spaceId}/close`, { method: "POST" }).then((response) => response.json());
  if (!closeBackground.ok) throw new Error(`close background Space failed: ${JSON.stringify(closeBackground)}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  const afterBackgroundClose = await presentationStatus(controlSocket);
  if (afterBackgroundClose.visibleSpaceId !== createdSpaceId ||
      !hasSpaceControls(afterBackgroundClose, createdSpaceId)) {
    throw new Error(`Closing a background Space removed the presented controls: ${JSON.stringify(afterBackgroundClose)}`);
  }
  const nativeClose = await sendSocket(controlSocket, JSON.stringify({
    command: "request-window-close-space",
    spaceId: createdSpaceId,
  }));
  if (nativeClose !== "ok") throw new Error(`native close request failed: ${nativeClose}`);
  const closeDeadline = Date.now() + 5_000;
  while (Date.now() < closeDeadline) {
    const current = await fetch(spacesUrl).then((response) => response.json());
    if (!current.spaces?.some((space) => space.id === createdSpaceId)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  const afterNativeClose = await fetch(spacesUrl).then((response) => response.json());
  if (afterNativeClose.spaces?.some((space) => space.id === createdSpaceId)) {
    throw new Error("Native window close did not remove the durable Space record");
  }
  let returnedPresentation;
  const overviewDeadline = Date.now() + 5_000;
  while (Date.now() < overviewDeadline) {
    returnedPresentation = await presentationStatus(controlSocket);
    if (returnedPresentation.overviewPresented &&
        returnedPresentation.presentedWindowCount === 1) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  if (!returnedPresentation.overviewPresented ||
      returnedPresentation.presentedWindowCount !== 1 ||
      returnedPresentation.visibleSpaceId !== 0 ||
      hasAnySpaceControls(returnedPresentation)) {
    throw new Error(`Closing the visible Space must return to one Overview window: ${JSON.stringify(returnedPresentation)}`);
  }
  console.log(JSON.stringify({
    spaceId,
    createdSpaceId,
    overview: info.url,
    opened: true,
    closed: true,
    onePresentedWindow: true,
    backgroundBootstrapDoesNotFlash: true,
    chromeControlsFollowWarmSpace: true,
    nativeChromeToolbarAttached: true,
    nativeChromeProductShell: nativeProductShell,
    spacesMountInsideUfoController: nativeProductShell,
    backgroundClosePreservesControls: true,
    agentOwnedNativeCloseBlocked: true,
    nativeCloseUsesSpaceStateMachine: true,
    backgroundCompositorSleeps: true,
    previewWakesOneSpaceOnDemand: true,
  }));
} finally {
  if (cli && cli.exitCode === null) cli.kill("SIGTERM");
  await app.stop();
  await rm(controlSocket, { force: true }).catch(() => undefined);
  await rm(presentationSocket, { force: true }).catch(() => undefined);
}

async function presentationStatus(path) {
  return JSON.parse(await sendSocket(path, JSON.stringify({ command: "presentation-status" })));
}

function hasSpaceControls(status, spaceId) {
  if (nativeProductShell) {
    return status.nativeChromeSpaceIds?.includes(spaceId) &&
      status.controllerMountedSpaceIds?.includes(spaceId) &&
      status.nativeSpacesButtonSpaceIds?.includes(spaceId) &&
      status.nativeCloseRoutedSpaceIds?.includes(spaceId);
  }
  return status.chromeToolbarSpaceIds?.includes(spaceId) &&
    status.chromeControlsPresented &&
    status.chromeControlsSpaceId === spaceId;
}

function hasAnySpaceControls(status) {
  if (nativeProductShell) {
    return (status.nativeSpacesButtonSpaceIds?.length || 0) > 0;
  }
  return Boolean(status.chromeControlsPresented);
}

function sendSocket(path, command) {
  return new Promise((resolveStatus, reject) => {
    const socket = createConnection(path);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", reject);
    socket.once("close", () => {
      resolveStatus(response.trim());
    });
    // Match the native AppKit controls: keep the client writable side open
    // until UFO has processed the command and closed the response stream.
    socket.once("connect", () => socket.write(`${command}\n`));
  });
}
