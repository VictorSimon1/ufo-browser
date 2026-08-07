import type { ImportedChromeCookie } from "./cookies.js";

export type CookieApi = {
  set(details: Electron.CookiesSetDetails): Promise<void>;
  get(filter: Electron.CookiesGetFilter): Promise<Electron.Cookie[]>;
};

export type CookieCdp = {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
};

export type CookieWriteTarget = {
  cookies: CookieApi;
  cdp: CookieCdp;
  flush(): Promise<void> | void;
  dispose(): Promise<void> | void;
};

export type CookieWriteResult = {
  written: number;
  partitioned: number;
  verified: number;
};

export async function writeAndVerifyCookies(
  target: CookieWriteTarget,
  cookies: ImportedChromeCookie[],
  concurrency = 8,
): Promise<CookieWriteResult> {
  const regular = cookies.filter((cookie) => !cookie.partitionKey);
  const partitioned = cookies.filter((cookie) => cookie.partitionKey);
  await mapWithConcurrency(regular, concurrency, async (cookie) => {
    await target.cookies.set(toElectronCookie(cookie));
  });
  await mapWithConcurrency(partitioned, Math.min(concurrency, 4), async (cookie) => {
    const result = await target.cdp.send("Network.setCookie", toCdpCookie(cookie));
    if (result?.success === false) throw new Error("partitioned Cookie write failed");
  });
  await target.flush();
  const verified = await verifyCookies(target, cookies);
  if (verified !== cookies.length) {
    throw new Error(
      `Chrome Cookie verification failed (${cookies.length - verified} mismatches)`,
    );
  }
  return {
    written: cookies.length,
    partitioned: partitioned.length,
    verified,
  };
}

export function cookieUrl(cookie: ImportedChromeCookie) {
  const host = cookie.domain.startsWith(".")
    ? cookie.domain.slice(1)
    : cookie.domain;
  if (!host || /[\s/\\]/.test(host)) throw new Error("invalid Cookie domain");
  const scheme = cookie.secure || cookie.sourceScheme === "Secure" ? "https" : "http";
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = new URL(`${scheme}://${urlHost}`);
  url.pathname = cookie.path.startsWith("/") ? cookie.path : "/";
  return url.toString();
}

function toElectronCookie(cookie: ImportedChromeCookie): Electron.CookiesSetDetails {
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? undefined : cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  };
}

function toCdpCookie(cookie: ImportedChromeCookie) {
  const sameSite =
    cookie.sameSite === "no_restriction"
      ? "None"
      : cookie.sameSite === "lax"
        ? "Lax"
        : cookie.sameSite === "strict"
          ? "Strict"
          : undefined;
  return {
    name: cookie.name,
    value: cookie.value,
    url: cookieUrl(cookie),
    domain: cookie.hostOnly ? undefined : cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite,
    expires: cookie.expirationDate,
    priority: cookie.priority,
    sourceScheme: cookie.sourceScheme,
    sourcePort: cookie.sourcePort,
    partitionKey: cookie.partitionKey,
  };
}

async function verifyCookies(
  target: CookieWriteTarget,
  expected: ImportedChromeCookie[],
) {
  const regularActual = await target.cookies.get({});
  let partitionedActual: any[] = [];
  if (expected.some((cookie) => cookie.partitionKey)) {
    // Storage.getCookies is browser-context scoped and returns the default
    // Electron context when the debugger target belongs to a persistent
    // custom Session. Network.getAllCookies is scoped to the target's actual
    // Session and preserves CHIPS partition keys for exact verification.
    const result = await target.cdp.send("Network.getAllCookies");
    partitionedActual = Array.isArray(result?.cookies)
      ? result.cookies.filter((cookie: any) => cookie.partitionKey)
      : [];
  }
  let verified = 0;
  for (const cookie of expected) {
    if (cookie.partitionKey) {
      if (partitionedActual.some((actual) => cdpCookieMatches(cookie, actual))) {
        verified++;
      }
    } else if (regularActual.some((actual) => electronCookieMatches(cookie, actual))) {
      verified++;
    }
  }
  return verified;
}

function electronCookieMatches(
  expected: ImportedChromeCookie,
  actual: Electron.Cookie,
) {
  return (
    actual.name === expected.name &&
    actual.value === expected.value &&
    normalizeDomain(actual.domain ?? "") === normalizeDomain(expected.domain) &&
    Boolean(actual.hostOnly) === expected.hostOnly &&
    (actual.path ?? "/") === expected.path &&
    Boolean(actual.secure) === expected.secure &&
    Boolean(actual.httpOnly) === expected.httpOnly &&
    actual.sameSite === expected.sameSite &&
    closeExpiration(actual.expirationDate, expected.expirationDate)
  );
}

function cdpCookieMatches(expected: ImportedChromeCookie, actual: any) {
  const actualSameSite =
    actual.sameSite === "None"
      ? "no_restriction"
      : actual.sameSite === "Lax"
        ? "lax"
        : actual.sameSite === "Strict"
          ? "strict"
          : "unspecified";
  return (
    actual.name === expected.name &&
    actual.value === expected.value &&
    normalizeDomain(String(actual.domain ?? "")) === normalizeDomain(expected.domain) &&
    String(actual.path ?? "/") === expected.path &&
    Boolean(actual.secure) === expected.secure &&
    Boolean(actual.httpOnly) === expected.httpOnly &&
    actualSameSite === expected.sameSite &&
    closeExpiration(Number(actual.expires), expected.expirationDate) &&
    normalizePartitionSite(actual.partitionKey?.topLevelSite) ===
      normalizePartitionSite(expected.partitionKey?.topLevelSite) &&
    Boolean(actual.partitionKey?.hasCrossSiteAncestor) ===
      expected.partitionKey?.hasCrossSiteAncestor
  );
}

function normalizePartitionSite(value: unknown) {
  const site = String(value ?? "").trim();
  try {
    const url = new URL(site);
    if (url.protocol !== "http:" && url.protocol !== "https:") return site;
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return site.replace(/\/$/, "").toLowerCase();
  }
}

function normalizeDomain(domain: string) {
  return domain.replace(/^\./, "").toLowerCase();
}

function closeExpiration(actual: number | undefined, expected: number) {
  return typeof actual === "number" && Math.abs(actual - expected) <= 1;
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("invalid Cookie import concurrency");
  }
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next++;
        await operation(values[index]);
      }
    },
  );
  await Promise.all(workers);
}
