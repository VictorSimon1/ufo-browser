import { createHash } from "node:crypto";
import type { ImportedChromeCookie } from "../chrome-import/cookies.js";

export type CookieSyncCheckpointEntry = {
  sourceHash: string | null;
  targetHash: string | null;
  updatedAt: number;
};

export type CookieSyncCheckpoint = Record<string, CookieSyncCheckpointEntry>;

export type CookieSyncDiff = {
  set: ImportedChromeCookie[];
  remove: ImportedChromeCookie[];
  checkpoint: CookieSyncCheckpoint;
  stats: {
    baselined: number;
    sourceChanged: number;
    set: number;
    removed: number;
    conflicts: number;
  };
};

export function diffProfileCookies(
  sourceCookies: readonly ImportedChromeCookie[],
  targetCookies: readonly ImportedChromeCookie[],
  previous: CookieSyncCheckpoint | undefined,
  now = Date.now(),
): CookieSyncDiff {
  const source = indexCookies(sourceCookies, sourceCookieHash);
  const target = indexCookies(targetCookies, targetCookieHash);
  const checkpoint: CookieSyncCheckpoint = {};
  const set: ImportedChromeCookie[] = [];
  const remove: ImportedChromeCookie[] = [];
  const stats = {
    baselined: 0,
    sourceChanged: 0,
    set: 0,
    removed: 0,
    conflicts: 0,
  };
  const keys = new Set([
    ...source.keys(),
    ...target.keys(),
    ...Object.keys(previous ?? {}),
  ]);

  for (const key of keys) {
    const sourceState = source.get(key);
    const targetState = target.get(key);
    const before = previous?.[key];
    const sourceHash = sourceState?.hash ?? null;
    const targetHash = targetState?.hash ?? null;

    if (!before) {
      checkpoint[key] = { sourceHash, targetHash, updatedAt: now };
      stats.baselined++;
      continue;
    }

    if (sourceHash === before.sourceHash) {
      // Deliberately retain the target hash from the last source checkpoint.
      // A UFO-side logout or login remains a divergence until the source
      // really changes, at which point conflict resolution preserves UFO.
      checkpoint[key] = before;
      continue;
    }

    stats.sourceChanged++;
    const targetChanged = targetHash !== before.targetHash;
    if (targetChanged) {
      checkpoint[key] = { sourceHash, targetHash, updatedAt: now };
      stats.conflicts++;
      continue;
    }

    if (sourceState) {
      set.push(sourceState.cookie);
      const appliedHash = targetCookieHash(sourceState.cookie);
      checkpoint[key] = {
        sourceHash,
        targetHash: appliedHash,
        updatedAt: now,
      };
      stats.set++;
      continue;
    }

    if (targetState) {
      remove.push(targetState.cookie);
      stats.removed++;
    }
    checkpoint[key] = { sourceHash: null, targetHash: null, updatedAt: now };
  }

  return { set, remove, checkpoint, stats };
}

export function cookieIdentityHash(cookie: ImportedChromeCookie) {
  return sha256(
    JSON.stringify([
      cookie.name,
      normalizeDomain(cookie.domain),
      cookie.path || "/",
      normalizePartitionSite(cookie.partitionKey?.topLevelSite),
      Boolean(cookie.partitionKey?.hasCrossSiteAncestor),
    ]),
  );
}

export function sourceCookieHash(cookie: ImportedChromeCookie) {
  return sha256(
    JSON.stringify([
      cookieIdentityHash(cookie),
      cookie.value,
      cookie.hostOnly,
      cookie.secure,
      cookie.httpOnly,
      cookie.sameSite,
      cookie.wasSessionCookie ? "session" : normalizedExpiration(cookie),
      cookie.priority,
      cookie.sourceScheme,
      cookie.sourcePort,
      cookie.sourceType,
    ]),
  );
}

export function targetCookieHash(cookie: ImportedChromeCookie) {
  return sha256(
    JSON.stringify([
      cookieIdentityHash(cookie),
      cookie.value,
      cookie.hostOnly,
      cookie.secure,
      cookie.httpOnly,
      cookie.sameSite,
      normalizedExpiration(cookie),
    ]),
  );
}

function indexCookies(
  cookies: readonly ImportedChromeCookie[],
  fingerprint: (cookie: ImportedChromeCookie) => string,
) {
  const index = new Map<
    string,
    { cookie: ImportedChromeCookie; hash: string }
  >();
  for (const cookie of cookies) {
    index.set(cookieIdentityHash(cookie), {
      cookie,
      hash: fingerprint(cookie),
    });
  }
  return index;
}

function normalizedExpiration(cookie: ImportedChromeCookie) {
  const value = Number(cookie.expirationDate);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeDomain(domain: string) {
  return String(domain).replace(/^\./, "").toLowerCase();
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

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
