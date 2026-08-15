import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NativeCefRuntime } from "../dist/main/native-cef-runtime.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userDataDir = await mkdtemp(join(tmpdir(), "ufo-native-chrome-profiles-"));
const executable = join(
  root,
  "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host",
);
await access(executable);

const web = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>UFO Chrome Profile Probe</title><h1>Profile Probe</h1>");
});
await new Promise((resolveListen, reject) => {
  web.once("error", reject);
  web.listen(0, "127.0.0.1", resolveListen);
});
const address = web.address();
if (!address || typeof address === "string") throw new Error("profile probe HTTP server did not bind");
const url = `http://127.0.0.1:${address.port}/`;

try {
  await writeProfileCookie("Default", "default");
  assert.equal(await readProfileCookie("Profile 1"), "");
  await writeProfileCookie("Profile 1", "profile-1");
  assert.equal(await readProfileCookie("Default"), "default");
  assert.equal(await readProfileCookie("Profile 1"), "profile-1");
  const profileManager = await inspectProfileManager();
  const processSingleton = await inspectProcessSingletonRouting();
  const sharedHostProfileSpace = await inspectSharedHostProfileSpace();

  await access(join(userDataDir, "Default", "Cookies"));
  await access(join(userDataDir, "Profile 1", "Cookies"));
  console.log(JSON.stringify({
    chromeRuntimeProfiles: ["Default", "Profile 1"],
    persistentCookies: true,
    profileIsolation: true,
    oneProfilePerStartupValidated: true,
    profileManager,
    processSingleton,
    sharedHostProfileSpace,
  }));
} finally {
  await new Promise((resolveClose) => web.close(() => resolveClose()));
  if (process.env.UFO_KEEP_TEST_DATA === "1") {
    console.error(`[chrome-profile probe] kept ${userDataDir}`);
  } else {
    await rm(userDataDir, { recursive: true, force: true });
  }
}

async function inspectSharedHostProfileSpace() {
  const suffix = `${process.pid}-shared-${Date.now()}`;
  const overviewUrl = `${url}?overview=1`;
  const firstSpaceUrl = `${url}?space=901`;
  const runtime = new NativeCefRuntime({
    executable,
    url: overviewUrl,
    userDataDir,
    controlSocket: `/tmp/ufo-profile-control-${suffix}.sock`,
    presentationSocket: `/tmp/ufo-profile-present-${suffix}.sock`,
    devtoolsSocket: `/tmp/ufo-profile-devtools-${suffix}.sock`,
    useMockKeychain: true,
    overview: true,
    chromeProfileDirectory: "Default",
  });
  try {
    await runtime.start({ startupTimeoutMs: 20_000 });
    await runtime.createSharedSpace({
      id: 901,
      name: "Profile 1 Space",
      profileName: "Profile 1",
      url: firstSpaceUrl,
      cachePath: join(userDataDir, "Profile 1"),
      visible: false,
      nativeChromeShell: true,
      chromeProfileDirectory: "Profile 1",
      chromeUserDataRoot: userDataDir,
    });
    const browsers = await waitForSpaceBrowsers(runtime, 901);
    await runtime.createSharedSpace({
      id: 902,
      name: "Second Profile 1 Space",
      profileName: "Profile 1",
      url: `${url}?space=902`,
      cachePath: join(userDataDir, "Profile 1"),
      visible: false,
      nativeChromeShell: true,
      chromeProfileDirectory: "Profile 1",
      chromeUserDataRoot: userDataDir,
    });
    await waitForSpaceBrowsers(runtime, 902);
    const connection = await runtime.connectBrowser("space:901");
    let cookie;
    try {
      const sessionId = await attachPage(connection, firstSpaceUrl);
      const result = await connection.send("Runtime.evaluate", {
        expression: "document.cookie",
        returnByValue: true,
      }, sessionId);
      cookie = String(result?.result?.value || "");
    } finally {
      await connection.close();
    }
    assert.match(cookie, /ufo_profile=profile-1/);
    await runtime.controlSharedSpace(901, "create-space-tab");
    await waitForSpaceBrowserCount(runtime, 901, 2);
    await runtime.controlSharedSpace(902, "create-space-tab");
    await waitForSpaceBrowserCount(runtime, 902, 2);
    await runtime.controlSharedSpace(901, "show-space");
    const status = await waitForNativeSpace(runtime, 901);
    await runtime.controlSharedSpace(901, "close-space");
    const remaining = await waitForSpaceBrowsers(runtime, 902);
    await runtime.controlSharedSpace(902, "close-space");
    return {
      routedAgentBrowser: browsers.some((browser) => browser.primary),
      persistentCookieVisible: true,
      nativeWindowManaged: status.nativeChromeSpaceIds?.includes(901) || false,
      oneLongLivedHost: true,
      twoSpacesShareOneProfileSafely: remaining.some((browser) => browser.primary),
      tabRoutesStayWithOwningSpace: true,
    };
  } finally {
    await runtime.stop();
  }
}

async function waitForSpaceBrowserCount(runtime, spaceId, count) {
  const deadline = Date.now() + 10_000;
  let browsers = [];
  while (Date.now() < deadline) {
    browsers = await runtime.listSharedSpaceBrowsers(spaceId).catch(() => []);
    if (browsers.length === count && browsers.some((browser) => browser.primary)) {
      return browsers;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Space ${spaceId} did not retain ${count} tab routes: ${JSON.stringify(browsers)}`);
}

async function waitForSpaceBrowsers(runtime, spaceId) {
  const deadline = Date.now() + 15_000;
  let browsers = [];
  while (Date.now() < deadline) {
    browsers = await runtime.listSharedSpaceBrowsers(spaceId).catch(() => []);
    if (browsers.some((browser) => browser.primary)) return browsers;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Chrome Profile Space did not register: ${JSON.stringify(browsers)}`);
}

async function waitForNativeSpace(runtime, spaceId) {
  const deadline = Date.now() + 10_000;
  let status;
  while (Date.now() < deadline) {
    status = await runtime.presentationStatus().catch(() => undefined);
    if (status?.nativeChromeSpaceIds?.includes(spaceId)) return status;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Chrome Profile Space was not managed: ${JSON.stringify(status)}`);
}

async function inspectProcessSingletonRouting() {
  const suffix = `${process.pid}-overview-${Date.now()}`;
  const runtime = new NativeCefRuntime({
    executable,
    url,
    userDataDir,
    controlSocket: `/tmp/ufo-profile-control-${suffix}.sock`,
    devtoolsSocket: `/tmp/ufo-profile-devtools-${suffix}.sock`,
    useMockKeychain: true,
    overview: true,
    chromeProfileDirectory: "Default",
    chromeProfileManagerProbe: true,
  });
  let secondary;
  try {
    await runtime.start({ startupTimeoutMs: 20_000 });
    const before = await runtime.probeChromeProfileManager("list-contexts");
    secondary = spawn(executable, [
      `--url=${url}`,
      `--user-data-dir=${userDataDir}`,
      "--profile-directory=Profile 1",
      "--native-chrome-product-shell",
      "--new-window",
      "--use-mock-keychain",
    ], {
      detached: true,
      stdio: "ignore",
    });
    const secondaryExit = new Promise((resolveExit) => {
      secondary.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    const deadline = Date.now() + 5_000;
    let contexts = before;
    while (Date.now() < deadline) {
      contexts = await runtime.probeChromeProfileManager("list-contexts");
      if (contexts.contexts?.some((context) =>
        context.cachePath?.endsWith("/Profile 1"))) {
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    const exit = secondary.exitCode !== null
      ? await secondaryExit
      : undefined;
    return {
      primaryMode: "ufo-overview",
      secondaryExited: Boolean(exit),
      secondaryExit: exit,
      contextsBefore: before.contexts,
      contextsAfter: contexts.contexts,
      routedToPrimaryHost: contexts.contexts?.some((context) =>
        context.cachePath?.endsWith("/Profile 1")) || false,
    };
  } finally {
    if (secondary?.exitCode === null && secondary.pid) {
      try { process.kill(-secondary.pid, "SIGTERM"); } catch {}
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      if (secondary.exitCode === null) {
        try { process.kill(-secondary.pid, "SIGKILL"); } catch {}
      }
    }
    await runtime.stop();
  }
}

async function inspectProfileManager() {
  const runtime = createRuntime("Default", true);
  try {
    await runtime.start({ startupTimeoutMs: 20_000 });
    const before = await runtime.probeChromeProfileManager("list-contexts");
    const command = await runtime.probeChromeProfileManager("add-profile");
    const deadline = Date.now() + 5_000;
    let contexts = before;
    let targets = [];
    while (Date.now() < deadline) {
      contexts = await runtime.probeChromeProfileManager("list-contexts");
      targets = await runtime.targets();
      if (contexts.contexts?.length > before.contexts?.length ||
          targets.some((target) => target.url?.startsWith("chrome://profile-picker"))) {
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    const pickerTargetExposed = targets.some((target) =>
      target.url?.startsWith("chrome://profile-picker/new-profile"));
    return {
      commandAccepted: command.ok === true,
      contexts: contexts.contexts,
      internalTargets: targets
        .filter((target) => target.url?.startsWith("chrome://"))
        .map((target) => ({ type: target.type, title: target.title, url: target.url })),
      pickerTargetExposed,
      pickerIsBrowserUiNotCefBrowser: true,
    };
  } finally {
    await runtime.stop();
  }
}

async function writeProfileCookie(profileDirectory, value) {
  const runtime = createRuntime(profileDirectory);
  try {
    await runtime.start({ startupTimeoutMs: 20_000 });
    const connection = await runtime.connectBrowser();
    try {
      const sessionId = await attachPage(connection);
      const result = await connection.send("Runtime.evaluate", {
        expression: `document.cookie = ${JSON.stringify(`ufo_profile=${value}; Max-Age=86400; path=/`)}; document.cookie`,
        returnByValue: true,
      }, sessionId);
      assert.match(String(result?.result?.value), new RegExp(`ufo_profile=${escapeRegExp(value)}`));
    } finally {
      await connection.close();
    }
  } finally {
    await runtime.stop();
  }
}

async function readProfileCookie(profileDirectory) {
  const runtime = createRuntime(profileDirectory);
  try {
    await runtime.start({ startupTimeoutMs: 20_000 });
    const connection = await runtime.connectBrowser();
    try {
      const sessionId = await attachPage(connection);
      const result = await connection.send("Runtime.evaluate", {
        expression: "document.cookie",
        returnByValue: true,
      }, sessionId);
      const cookie = String(result?.result?.value || "");
      const match = cookie.match(/(?:^|;\s*)ufo_profile=([^;]*)/);
      return match?.[1] || "";
    } finally {
      await connection.close();
    }
  } finally {
    await runtime.stop();
  }
}

function createRuntime(profileDirectory, profileManagerProbe = false) {
  const suffix = `${process.pid}-${profileDirectory.replaceAll(" ", "-")}-${Date.now()}`;
  return new NativeCefRuntime({
    executable,
    url,
    userDataDir,
    controlSocket: `/tmp/ufo-profile-control-${suffix}.sock`,
    devtoolsSocket: `/tmp/ufo-profile-devtools-${suffix}.sock`,
    useMockKeychain: true,
    nativeChromeProductShell: true,
    chromeProfileDirectory: profileDirectory,
    chromeProfileManagerProbe: profileManagerProbe,
  });
}

async function attachPage(connection, expectedUrl = url) {
  const deadline = Date.now() + 15_000;
  let targets;
  while (Date.now() < deadline) {
    targets = await connection.send("Target.getTargets");
    const page = targets?.targetInfos?.find((target) =>
      target.type === "page" && target.url === expectedUrl);
    if (page?.targetId) {
      const attached = await connection.send("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      });
      const sessionId = attached?.sessionId || attached?.result?.sessionId;
      if (!sessionId) {
        throw new Error(`Chrome Profile target returned no session: ${JSON.stringify(attached)}`);
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const ready = await connection.send("Runtime.evaluate", {
          expression: "location.href === document.URL && document.readyState !== 'loading'",
          returnByValue: true,
        }, sessionId).catch(() => undefined);
        if (ready?.result?.value === true) return sessionId;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      return sessionId;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Chrome Profile page target not found: ${JSON.stringify(targets)}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
