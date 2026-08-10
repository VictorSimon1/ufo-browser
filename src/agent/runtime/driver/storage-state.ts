// @ts-nocheck
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cdp, evaluate } from "../cdp-eval.js";
import { state } from "../state.js";

type StorageStateOptions = { path?: string };
type SetStorageStateOptions = { clear?: boolean };

/** Capture browser cookies and localStorage for the current page origin. */
export async function storageState(options: StorageStateOptions = {}) {
  const [cookieResult, originState] = await Promise.all([
    cdp("Network.getAllCookies"),
    evaluate(`(() => {
      try {
        if (location.origin === "null") return null;
        return {
          origin: location.origin,
          localStorage: Object.keys(localStorage).map((name) => ({
            name,
            value: localStorage.getItem(name) ?? "",
          })),
        };
      } catch {
        return null;
      }
    })()`),
  ]);
  const result = {
    cookies: (cookieResult.cookies || []).map(serializableCookie),
    origins: originState ? [originState] : [],
  };
  if (options.path !== undefined) {
    const path = String(options.path);
    await mkdir(dirname(path), { recursive: true });
    await state.writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

/** Restore cookies and localStorage from an object or saved state file. */
export async function setStorageState(
  stateOrPath,
  options: SetStorageStateOptions = {},
) {
  const input =
    typeof stateOrPath === "string"
      ? JSON.parse(await readFile(stateOrPath, "utf8"))
      : stateOrPath;
  if (!input || typeof input !== "object") {
    throw new TypeError("page.setStorageState expects a state object or JSON path");
  }
  const cookies = Array.isArray(input.cookies) ? input.cookies : [];
  const origins = Array.isArray(input.origins) ? input.origins : [];
  if (options.clear) {
    await cdp("Network.clearBrowserCookies");
  }
  if (cookies.length > 0) {
    const result = await cdp("Network.setCookies", {
      cookies: cookies.map(cookieParam),
    });
    if (result.success === false) {
      throw new Error("page.setStorageState failed to restore cookies");
    }
  }
  const currentOrigin = await evaluate("location.origin").catch(() => "null");
  for (const originState of origins) {
    if (typeof originState?.origin !== "string") continue;
    const entries = Array.isArray(originState.localStorage)
      ? originState.localStorage
          .filter((entry) => entry && typeof entry.name === "string")
          .map((entry) => ({
            name: entry.name,
            value: String(entry.value ?? ""),
          }))
      : [];
    if (originState.origin === currentOrigin) {
      await evaluate(
        ({ entries, clear }) => {
          if (clear) localStorage.clear();
          for (const entry of entries) {
            localStorage.setItem(entry.name, entry.value);
          }
        },
        { entries, clear: Boolean(options.clear) },
      );
      continue;
    }
    const storageId = {
      securityOrigin: originState.origin,
      isLocalStorage: true,
    };
    if (options.clear) {
      await cdp("DOMStorage.clear", { storageId }).catch(() => undefined);
    }
    for (const entry of entries) {
      await cdp("DOMStorage.setDOMStorageItem", {
        storageId,
        key: entry.name,
        value: entry.value,
      });
    }
  }
  return { cookies: cookies.length, origins: origins.length };
}

function serializableCookie(cookie) {
  const result: any = {
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    domain: String(cookie.domain || ""),
    path: String(cookie.path || "/"),
    expires: Number(cookie.expires ?? -1),
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: cookie.sameSite || "Lax",
  };
  for (const key of ["priority", "sameParty", "sourceScheme", "sourcePort", "partitionKey"]) {
    if (cookie[key] !== undefined) result[key] = cookie[key];
  }
  return result;
}

function cookieParam(cookie) {
  if (!cookie || typeof cookie !== "object") {
    throw new TypeError("storageState cookies must be objects");
  }
  const result: any = {
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    domain: String(cookie.domain || ""),
    path: String(cookie.path || "/"),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (Number(cookie.expires) >= 0) result.expires = Number(cookie.expires);
  if (["Strict", "Lax", "None"].includes(cookie.sameSite)) {
    result.sameSite = cookie.sameSite;
  }
  for (const key of ["priority", "sameParty", "sourceScheme", "sourcePort", "partitionKey"]) {
    if (cookie[key] !== undefined) result[key] = cookie[key];
  }
  return result;
}
