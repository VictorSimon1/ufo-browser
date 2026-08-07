import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromiumAcceptLanguages,
  chromiumLowEntropyClientHints,
  configureChromiumSession,
  ensureChromiumProfilePreferences,
  mergeChromiumClientHintHeaders,
  proxyRulesFromEnvironment,
  reducedChromiumUserAgent,
} from "../main/chromium-identity.js";

test("reduced UA matches the embedded Chromium major without Electron markers", () => {
  const ua = reducedChromiumUserAgent("138.0.7204.251");
  assert.match(ua, /Chrome\/138\.0\.0\.0/);
  assert.doesNotMatch(ua, /Electron/);
});

test("accept languages match the native ego-lite Chromium profile", () => {
  assert.equal(chromiumAcceptLanguages, "zh-CN,zh");
});

test("session UA setup supplies the ego-compatible language list", async () => {
  const userAgentCalls: unknown[][] = [];
  let permissionCheck: ((contents: unknown, permission: string) => boolean) | undefined;
  let permissionRequest:
    | ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void)
    | undefined;
  const chromiumSession = {
    setUserAgent: (...args: unknown[]) => userAgentCalls.push(args),
    setPermissionCheckHandler: (handler: typeof permissionCheck) => {
      permissionCheck = handler;
    },
    setPermissionRequestHandler: (handler: typeof permissionRequest) => {
      permissionRequest = handler;
    },
    webRequest: {
      onBeforeSendHeaders: () => undefined,
    },
    setProxy: async () => undefined,
  };
  await configureChromiumSession(
    chromiumSession as any,
    "150.0.7871.129",
    {},
  );
  assert.deepEqual(userAgentCalls, [
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/150.0.0.0 Safari/537.36",
      chromiumAcceptLanguages,
    ],
  ]);
  assert.equal(
    permissionCheck,
    undefined,
    "native Chromium permission status queries remain installed",
  );
  let requested: boolean | undefined;
  permissionRequest?.(null, "notifications", (allowed) => (requested = allowed));
  assert.equal(requested, false);
  permissionRequest?.(null, "clipboard-sanitized-write", (allowed) =>
    (requested = allowed),
  );
  assert.equal(requested, true);
});

test("session setup is idempotent when import and Manager reuse one partition", async () => {
  let configured = 0;
  const chromiumSession = {
    setUserAgent: () => configured++,
    setPermissionRequestHandler: () => undefined,
    webRequest: { onBeforeSendHeaders: () => undefined },
    setProxy: async () => undefined,
  };
  await configureChromiumSession(chromiumSession as any, "150.0.0.0", {});
  await configureChromiumSession(chromiumSession as any, "150.0.0.0", {});
  assert.equal(configured, 1);
});

test("low entropy client hints match Chromium 150 native UAData", () => {
  assert.deepEqual(chromiumLowEntropyClientHints("150.0.7871.129", "darwin"), {
    "Sec-CH-UA": '"Not;A=Brand";v="8", "Chromium";v="150"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
  });
});

test("client hint merge preserves native headers when Chromium supplies them", () => {
  assert.deepEqual(
    mergeChromiumClientHintHeaders(
      { "sec-ch-ua": '"native";v="150"', Accept: "text/html" },
      "150.0.7871.129",
      "darwin",
    ),
    {
      "sec-ch-ua": '"native";v="150"',
      Accept: "text/html",
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"macOS"',
    },
  );
});

test("profile preferences store ego-compatible selected languages before session creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "x-browser-profile-prefs-"));
  try {
    await ensureChromiumProfilePreferences(root, "default");
    const preferences = JSON.parse(
      await readFile(
        join(root, "x-browser-profile-default", "Preferences"),
        "utf8",
      ),
    );
    assert.equal(preferences.intl.selected_languages, "zh-CN,zh");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proxy selection follows HTTPS, HTTP, then ALL proxy precedence", () => {
  assert.equal(
    proxyRulesFromEnvironment({
      https_proxy: "http://127.0.0.1:7890",
      all_proxy: "socks5://127.0.0.1:7891",
    }),
    "http://127.0.0.1:7890",
  );
  assert.equal(
    proxyRulesFromEnvironment({ all_proxy: "socks5://127.0.0.1:7890" }),
    "socks5://127.0.0.1:7890",
  );
});
