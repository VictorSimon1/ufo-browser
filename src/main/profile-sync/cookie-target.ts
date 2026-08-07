import type { ImportedChromeCookie } from "../chrome-import/cookies.js";
import {
  cookieUrl,
  toCdpCookie,
  writeAndVerifyCookies,
  type CookieWriteTarget,
} from "../chrome-import/cookie-writer.js";
import { cookieIdentityHash, type CookieSyncDiff } from "./cookie-diff.js";

export async function readProfileCookies(target: CookieWriteTarget) {
  const regular = (await target.cookies.get({})).map(electronCookie);
  const all = await target.cdp.send("Network.getAllCookies").catch(() => ({
    cookies: [],
  }));
  const partitioned = Array.isArray(all?.cookies)
    ? all.cookies
        .filter((cookie: any) => cookie?.partitionKey)
        .map(cdpCookie)
    : [];
  return [...regular, ...partitioned];
}

export async function applyProfileCookieDiff(
  target: CookieWriteTarget,
  diff: CookieSyncDiff,
) {
  await mapWithConcurrency(diff.remove, 8, async (cookie) => {
    if (cookie.partitionKey) {
      const details = toCdpCookie(cookie);
      await target.cdp.send("Network.deleteCookies", {
        name: details.name,
        url: details.url,
        domain: details.domain,
        path: details.path,
        partitionKey: details.partitionKey,
      });
      return;
    }
    if (!target.cookies.remove) {
      throw new Error("profile Cookie removal is not available");
    }
    await target.cookies.remove(cookieUrl(cookie), cookie.name);
  });
  if (diff.set.length > 0) {
    await writeAndVerifyCookies(target, diff.set);
  } else {
    await target.flush();
  }
  if (diff.remove.length > 0) {
    const remaining = new Set(
      (await readProfileCookies(target)).map(cookieIdentityHash),
    );
    if (diff.remove.some((cookie) => remaining.has(cookieIdentityHash(cookie)))) {
      throw new Error("profile Cookie removal verification failed");
    }
  }
}

function electronCookie(cookie: Electron.Cookie): ImportedChromeCookie {
  const expirationDate = Number(cookie.expirationDate) || 0;
  return {
    domain: String(cookie.domain || ""),
    hostOnly: Boolean(cookie.hostOnly),
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    path: String(cookie.path || "/") || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: normalizeSameSite(cookie.sameSite),
    expirationDate,
    wasSessionCookie: Boolean(cookie.session) || expirationDate <= 0,
    priority: "Medium",
    sourceScheme: cookie.secure ? "Secure" : "NonSecure",
    sourcePort: -1,
    sourceType: 0,
    lastUpdateChromeTime: "0",
  };
}

function cdpCookie(cookie: any): ImportedChromeCookie {
  const expirationDate = Number(cookie?.expires) || 0;
  return {
    domain: String(cookie?.domain || ""),
    hostOnly: !String(cookie?.domain || "").startsWith("."),
    name: String(cookie?.name || ""),
    value: String(cookie?.value || ""),
    path: String(cookie?.path || "/") || "/",
    secure: Boolean(cookie?.secure),
    httpOnly: Boolean(cookie?.httpOnly),
    sameSite: normalizeSameSite(cookie?.sameSite),
    expirationDate,
    wasSessionCookie: Boolean(cookie?.session) || expirationDate <= 0,
    priority:
      cookie?.priority === "Low" || cookie?.priority === "High"
        ? cookie.priority
        : "Medium",
    sourceScheme:
      cookie?.sourceScheme === "Secure" || cookie?.sourceScheme === "NonSecure"
        ? cookie.sourceScheme
        : "Unset",
    sourcePort: Number.isFinite(Number(cookie?.sourcePort))
      ? Number(cookie.sourcePort)
      : -1,
    sourceType: Number.isFinite(Number(cookie?.sourceType))
      ? Number(cookie.sourceType)
      : 0,
    lastUpdateChromeTime: "0",
    partitionKey: {
      topLevelSite: String(cookie?.partitionKey?.topLevelSite || ""),
      hasCrossSiteAncestor: Boolean(
        cookie?.partitionKey?.hasCrossSiteAncestor,
      ),
    },
  };
}

function normalizeSameSite(value: unknown): ImportedChromeCookie["sameSite"] {
  if (value === "no_restriction" || value === "None") return "no_restriction";
  if (value === "lax" || value === "Lax") return "lax";
  if (value === "strict" || value === "Strict") return "strict";
  return "unspecified";
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
) {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index++];
        await operation(item);
      }
    },
  );
  await Promise.all(workers);
}
