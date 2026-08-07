import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  CHROME_SAFE_STORAGE_SERVICE,
  type KeychainProvider,
} from "./keychain.js";

const CHROME_EPOCH_OFFSET_MICROSECONDS = 11_644_473_600_000_000n;
const SESSION_COOKIE_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const COOKIE_DECRYPTION_IV = Buffer.alloc(16, 0x20);

export type ImportedCookieSameSite =
  | "unspecified"
  | "no_restriction"
  | "lax"
  | "strict";

export type ImportedChromeCookie = {
  domain: string;
  hostOnly: boolean;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: ImportedCookieSameSite;
  expirationDate: number;
  wasSessionCookie: boolean;
  priority: "Low" | "Medium" | "High";
  sourceScheme: "Unset" | "NonSecure" | "Secure";
  sourcePort: number;
  sourceType: number;
  lastUpdateChromeTime: string;
  partitionKey?: {
    topLevelSite: string;
    hasCrossSiteAncestor: boolean;
  };
};

export type CookieImportWarningCode =
  | "expired-cookie"
  | "unsupported-encryption"
  | "decryption-failed"
  | "host-digest-mismatch"
  | "invalid-utf8"
  | "invalid-cookie-row";

export type CookieImportWarning = {
  code: CookieImportWarningCode;
  count: number;
};

export type ChromeCookieReadResult = {
  databaseVersion: number;
  cookies: ImportedChromeCookie[];
  warnings: CookieImportWarning[];
};

type CookieRow = Record<string, unknown>;

export async function readChromeCookies(
  databasePath: string,
  keychain: KeychainProvider,
  nowSeconds = Date.now() / 1000,
): Promise<ChromeCookieReadResult> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let safeStorageSecret: Buffer | undefined;
  let derivedKey: Buffer | undefined;
  try {
    const databaseVersion = readDatabaseVersion(database);
    const columns = new Set(
      database
        .prepare("PRAGMA table_info(cookies)")
        .all()
        .map((row: any) => String(row.name)),
    );
    assertRequiredCookieColumns(columns);
    const rows = database.prepare(cookieSelect(columns)).all() as CookieRow[];
    const cookies: ImportedChromeCookie[] = [];
    const warningCounts = new Map<CookieImportWarningCode, number>();

    for (const row of rows) {
      const encryptedValue = asBuffer(row.encrypted_value);
      if (encryptedValue.length && !hasSupportedEncryptionPrefix(encryptedValue)) {
        incrementWarning(warningCounts, "unsupported-encryption");
        continue;
      }
      if (encryptedValue.length && !derivedKey) {
        safeStorageSecret = await keychain.readSecret(
          CHROME_SAFE_STORAGE_SERVICE,
        );
        derivedKey = deriveChromeCookieKey(safeStorageSecret);
        safeStorageSecret.fill(0);
        safeStorageSecret = undefined;
      }
      try {
        let value = String(row.value ?? "");
        if (encryptedValue.length) {
          const decrypted = decryptChromeCookieValue(
            encryptedValue,
            derivedKey!,
            String(row.host_key ?? ""),
            databaseVersion,
          );
          if (!decrypted.ok) {
            incrementWarning(warningCounts, decrypted.warning);
            continue;
          }
          value = decrypted.value;
        }
        const converted = convertCookieRow(row, value, nowSeconds);
        if (!converted.ok) {
          incrementWarning(warningCounts, converted.warning);
          continue;
        }
        cookies.push(converted.cookie);
      } catch {
        incrementWarning(warningCounts, "invalid-cookie-row");
      }
    }
    return {
      databaseVersion,
      cookies,
      warnings: [...warningCounts.entries()].map(([code, count]) => ({
        code,
        count,
      })),
    };
  } finally {
    safeStorageSecret?.fill(0);
    derivedKey?.fill(0);
    database.close();
  }
}

function hasSupportedEncryptionPrefix(encryptedValue: Buffer) {
  const prefix = encryptedValue.subarray(0, 3).toString("ascii");
  return prefix === "v10" || prefix === "v11";
}

export function deriveChromeCookieKey(secret: Buffer) {
  return pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
}

export function chromeTimeToUnixSeconds(value: unknown) {
  try {
    const microseconds = BigInt(String(value));
    if (microseconds <= CHROME_EPOCH_OFFSET_MICROSECONDS) return 0;
    return Number(
      (microseconds - CHROME_EPOCH_OFFSET_MICROSECONDS) / 1_000_000n,
    );
  } catch {
    return 0;
  }
}

function readDatabaseVersion(database: DatabaseSync) {
  const row = database
    .prepare("SELECT value FROM meta WHERE key = 'version'")
    .get() as { value?: unknown } | undefined;
  const version = Number(row?.value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("unsupported Chrome Cookie database version");
  }
  return version;
}

function assertRequiredCookieColumns(columns: Set<string>) {
  for (const column of [
    "host_key",
    "name",
    "value",
    "encrypted_value",
    "path",
    "expires_utc",
    "is_secure",
    "is_httponly",
  ]) {
    if (!columns.has(column)) {
      throw new Error("unsupported Chrome Cookie database schema");
    }
  }
}

function cookieSelect(columns: Set<string>) {
  const optional = (column: string, fallback: string) =>
    columns.has(column) ? column : `${fallback} AS ${column}`;
  return `
    SELECT
      host_key,
      ${optional("top_frame_site_key", "''")},
      name,
      value,
      encrypted_value,
      path,
      CAST(expires_utc AS TEXT) AS expires_utc,
      is_secure,
      is_httponly,
      ${optional("has_expires", "0")},
      ${optional("is_persistent", "0")},
      ${optional("priority", "1")},
      ${optional("samesite", "-1")},
      ${optional("source_scheme", "0")},
      ${optional("source_port", "-1")},
      ${optional("source_type", "0")},
      ${columns.has("last_update_utc") ? "CAST(last_update_utc AS TEXT)" : "'0'"} AS last_update_utc,
      ${optional("has_cross_site_ancestor", "0")}
    FROM cookies
  `;
}

function decryptChromeCookieValue(
  encryptedValue: Buffer,
  key: Buffer,
  hostKey: string,
  databaseVersion: number,
):
  | { ok: true; value: string }
  | { ok: false; warning: CookieImportWarningCode } {
  const prefix = encryptedValue.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") {
    return { ok: false, warning: "unsupported-encryption" };
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, COOKIE_DECRYPTION_IV);
    plaintext = Buffer.concat([
      decipher.update(encryptedValue.subarray(3)),
      decipher.final(),
    ]);
  } catch {
    return { ok: false, warning: "decryption-failed" };
  }
  try {
    let valueBytes = plaintext;
    if (databaseVersion >= 24) {
      if (plaintext.length < 32) {
        return { ok: false, warning: "host-digest-mismatch" };
      }
      const expected = createHash("sha256").update(hostKey).digest();
      const actual = plaintext.subarray(0, 32);
      if (!timingSafeEqual(actual, expected)) {
        return { ok: false, warning: "host-digest-mismatch" };
      }
      valueBytes = plaintext.subarray(32);
    }
    try {
      return {
        ok: true,
        value: new TextDecoder("utf-8", { fatal: true }).decode(valueBytes),
      };
    } catch {
      return { ok: false, warning: "invalid-utf8" };
    }
  } finally {
    plaintext.fill(0);
  }
}

function convertCookieRow(
  row: CookieRow,
  value: string,
  nowSeconds: number,
):
  | { ok: true; cookie: ImportedChromeCookie }
  | { ok: false; warning: CookieImportWarningCode } {
  const domain = String(row.host_key ?? "");
  const name = String(row.name ?? "");
  const path = String(row.path ?? "/") || "/";
  if (!domain || !path.startsWith("/")) {
    return { ok: false, warning: "invalid-cookie-row" };
  }
  const sourceExpiration = chromeTimeToUnixSeconds(row.expires_utc);
  const hasExpires = Number(row.has_expires) !== 0 || Number(row.is_persistent) !== 0;
  if (hasExpires && sourceExpiration > 0 && sourceExpiration <= nowSeconds) {
    return { ok: false, warning: "expired-cookie" };
  }
  const wasSessionCookie = !hasExpires || sourceExpiration <= 0;
  const expirationDate = wasSessionCookie
    ? Math.floor(nowSeconds) + SESSION_COOKIE_LIFETIME_SECONDS
    : sourceExpiration;
  const topLevelSite = String(row.top_frame_site_key ?? "");
  return {
    ok: true,
    cookie: {
      domain,
      hostOnly: !domain.startsWith("."),
      name,
      value,
      path,
      secure: Number(row.is_secure) !== 0,
      httpOnly: Number(row.is_httponly) !== 0,
      sameSite: mapSameSite(Number(row.samesite)),
      expirationDate,
      wasSessionCookie,
      priority: mapPriority(Number(row.priority)),
      sourceScheme: mapSourceScheme(Number(row.source_scheme)),
      sourcePort: Number.isSafeInteger(Number(row.source_port))
        ? Number(row.source_port)
        : -1,
      sourceType: Number.isSafeInteger(Number(row.source_type))
        ? Number(row.source_type)
        : 0,
      lastUpdateChromeTime: String(row.last_update_utc ?? "0"),
      partitionKey: topLevelSite
        ? {
            topLevelSite,
            hasCrossSiteAncestor: Number(row.has_cross_site_ancestor) !== 0,
          }
        : undefined,
    },
  };
}

function mapSameSite(value: number): ImportedCookieSameSite {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
}

function mapPriority(value: number): "Low" | "Medium" | "High" {
  if (value <= 0) return "Low";
  if (value >= 2) return "High";
  return "Medium";
}

function mapSourceScheme(value: number): "Unset" | "NonSecure" | "Secure" {
  if (value === 1) return "NonSecure";
  if (value === 2) return "Secure";
  return "Unset";
}

function asBuffer(value: unknown) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.alloc(0);
}

function incrementWarning(
  counts: Map<CookieImportWarningCode, number>,
  code: CookieImportWarningCode,
) {
  counts.set(code, (counts.get(code) ?? 0) + 1);
}
