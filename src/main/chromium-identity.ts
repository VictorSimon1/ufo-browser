import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "electron";

export function reducedChromiumUserAgent(chromeVersion: string) {
  const major = chromeVersion.split(".")[0] || "138";
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export const chromiumAcceptLanguages = "zh-CN,zh";

const chromiumGreaseCharacters = [
  " ",
  "(",
  ":",
  "-",
  ".",
  "/",
  ")",
  ";",
  "=",
  "?",
  "_",
];
const chromiumGreaseVersions = ["8", "99", "24"];

export function chromiumLowEntropyClientHints(
  chromeVersion: string,
  platform = process.platform,
) {
  const major = Number.parseInt(chromeVersion.split(".")[0] || "0", 10) || 0;
  const first = chromiumGreaseCharacters[major % chromiumGreaseCharacters.length];
  const second =
    chromiumGreaseCharacters[(major + 1) % chromiumGreaseCharacters.length];
  const greaseBrand = `Not${first}A${second}Brand`;
  const greaseVersion = chromiumGreaseVersions[major % chromiumGreaseVersions.length];
  const brands = [
    `"${greaseBrand}";v="${greaseVersion}"`,
    `"Chromium";v="${major}"`,
  ];
  if (major % 2 === 1) brands.reverse();
  return {
    "Sec-CH-UA": brands.join(", "),
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": `"${platform === "darwin" ? "macOS" : platform}"`,
  };
}

export function mergeChromiumClientHintHeaders(
  requestHeaders: Record<string, string>,
  chromeVersion: string,
  platform = process.platform,
) {
  const merged = { ...requestHeaders };
  for (const [name, value] of Object.entries(
    chromiumLowEntropyClientHints(chromeVersion, platform),
  )) {
    const existing = Object.keys(merged).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (!existing) merged[name] = value;
  }
  return merged;
}

export async function ensureChromiumProfilePreferences(
  partitionsRoot: string,
  profileId: string,
) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profileId)) return;
  const directory = join(partitionsRoot, `x-browser-profile-${profileId}`);
  const preferencesPath = join(directory, "Preferences");
  let preferences: Record<string, any> = {};
  try {
    preferences = JSON.parse(await readFile(preferencesPath, "utf8"));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (preferences.intl?.selected_languages === chromiumAcceptLanguages) return;
  preferences.intl = {
    ...(preferences.intl ?? {}),
    selected_languages: chromiumAcceptLanguages,
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${preferencesPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(preferences), { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, preferencesPath);
}

export function proxyRulesFromEnvironment(
  env: Record<string, string | undefined> = process.env,
) {
  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    const value = env[key]?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (!["http:", "https:", "socks4:", "socks5:"].includes(url.protocol)) {
        continue;
      }
      return url.toString().replace(/\/$/, "");
    } catch {
      // Ignore malformed ambient proxy values.
    }
  }
  return undefined;
}

export async function configureChromiumSession(
  chromiumSession: Session,
  chromeVersion = process.versions.chrome,
  env: Record<string, string | undefined> = process.env,
) {
  // Keep UA, navigator.languages, and Accept-Language as close as Electron
  // allows to the native Chromium profile used by ego-lite. Electron appends
  // the standard q=0.9 weight to the second language itself.
  chromiumSession.setUserAgent(
    reducedChromiumUserAgent(chromeVersion),
    chromiumAcceptLanguages,
  );
  // Keep Chromium's native permission *status* store. Installing a global
  // check handler forces every unknown permission to either granted or denied,
  // erasing the native `prompt`/`default` state exposed by normal Chrome.
  // Actual permission prompts remain fail-closed below.
  chromiumSession.setPermissionRequestHandler?.(
    (_contents, permission, callback) => {
      callback(permission === "clipboard-sanitized-write");
    },
  );
  chromiumSession.webRequest.onBeforeSendHeaders(
    {
      // Secure cross-site challenges need the low-entropy hints that Electron
      // suppresses after setUserAgent(). Trustworthy localhost keeps Chromium's
      // native behavior so local fixtures are not silently rewritten.
      urls: ["https://*/*"],
    },
    (details, callback) => {
      callback({
        requestHeaders: mergeChromiumClientHintHeaders(
          details.requestHeaders,
          chromeVersion,
        ),
      });
    },
  );
  const proxyRules = proxyRulesFromEnvironment(env);
  if (proxyRules) {
    await chromiumSession.setProxy({ proxyRules });
  }
}
