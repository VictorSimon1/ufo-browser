import type { Session } from "electron";
import type { SpaceEventJournal } from "./space-event-journal.js";
import type { SpaceRecord } from "./types.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_URL_LENGTH = 8_192;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;

const FORBIDDEN_HEADERS = [
  /^cookie$/i,
  /^cookie2$/i,
  /^set-cookie2?$/i,
  /^host$/i,
  /^content-length$/i,
  /^connection$/i,
  /^keep-alive$/i,
  /^transfer-encoding$/i,
  /^te$/i,
  /^trailer$/i,
  /^upgrade$/i,
  /^proxy-/i,
  /^sec-/i,
  /^user-agent$/i,
  /^accept-language$/i,
];

export type ProfileRequestInput = {
  method?: unknown;
  headers?: unknown;
  body?: unknown;
  timeoutMs?: unknown;
  maxResponseBytes?: unknown;
  redirect?: unknown;
  credentials?: unknown;
};

export type ProfileRequestResult = {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  redirected: boolean;
  headers: Array<[string, string]>;
  bodyBase64: string;
  bytes: number;
};

type ProfileRequestManager = {
  getSpaceOrThrow(spaceId: number): SpaceRecord;
  profileSessionForSpace(spaceId: number): Promise<Session>;
};

export class ProfileRequestService {
  constructor(
    private readonly manager: ProfileRequestManager,
    private readonly journal?: SpaceEventJournal,
  ) {}

  async request(
    spaceId: number,
    connectionId: string,
    urlValue: unknown,
    optionsValue: ProfileRequestInput = {},
  ): Promise<ProfileRequestResult> {
    const space = this.manager.getSpaceOrThrow(spaceId);
    const tab = space.tabs.find((candidate) => candidate.targetId === space.activeTabId);
    if (!tab) throw profileRequestError("INVALID_URL", "active tab is missing");
    const url = resolveRequestUrl(urlValue, tab.url);
    const options = normalizeRequestOptions(optionsValue);
    const startedAt = performance.now();
    this.journal?.append({
      spaceId,
      connectionId,
      tabId: tab.targetId,
      category: "network",
      type: "network.profile-request.started",
      data: requestEventData(url, options.method),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const chromiumSession = await this.manager.profileSessionForSpace(spaceId);
      const response = await chromiumSession.fetch(url.toString(), {
        method: options.method,
        headers: options.headers,
        body: options.body,
        credentials: options.credentials,
        redirect: options.redirect,
        signal: controller.signal,
      });
      const body = await readBoundedBody(response, options.maxResponseBytes);
      const responseUrl = safeResponseUrl(response.url, url);
      const result: ProfileRequestResult = {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        url: responseUrl,
        redirected: response.redirected || responseUrl !== url.toString(),
        headers: publicResponseHeaders(response.headers),
        bodyBase64: body.toString("base64"),
        bytes: body.byteLength,
      };
      this.journal?.append({
        spaceId,
        connectionId,
        tabId: tab.targetId,
        category: "network",
        type: "network.profile-request.finished",
        data: {
          ...requestEventData(url, options.method),
          status: result.status,
          ok: result.ok,
          redirected: result.redirected,
          durationMs: Math.round(performance.now() - startedAt),
          bytes: result.bytes,
        },
      });
      return result;
    } catch (error: any) {
      const normalized = normalizeRequestError(error, controller.signal.aborted);
      this.journal?.append({
        spaceId,
        connectionId,
        tabId: tab.targetId,
        category: "network",
        type: "network.profile-request.failed",
        data: {
          ...requestEventData(url, options.method),
          durationMs: Math.round(performance.now() - startedAt),
          errorCode: normalized.code,
        },
      });
      throw normalized.error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function resolveRequestUrl(value: unknown, baseUrl: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw profileRequestError("INVALID_URL", "URL must be a non-empty string");
  }
  if (value.length > MAX_URL_LENGTH) {
    throw profileRequestError("INVALID_URL", "URL exceeds 8192 characters");
  }
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw profileRequestError(
      "INVALID_URL",
      "relative URL requires an HTTP(S) active tab",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw profileRequestError("INVALID_URL", "only HTTP(S) URLs are allowed");
  }
  if (url.username || url.password) {
    throw profileRequestError("INVALID_URL", "URL credentials are not allowed");
  }
  if (url.toString().length > MAX_URL_LENGTH) {
    throw profileRequestError("INVALID_URL", "resolved URL exceeds 8192 characters");
  }
  return url;
}

function normalizeRequestOptions(value: ProfileRequestInput) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw profileRequestError("INVALID_ARGUMENT", "options must be an object");
  }
  const method = String(value.method ?? "GET").trim().toUpperCase();
  if (!/^[A-Z!#$%&'*+.^_`|~-]{1,32}$/.test(method)) {
    throw profileRequestError("INVALID_METHOD", "request method is invalid");
  }
  if (["CONNECT", "TRACE", "TRACK"].includes(method)) {
    throw profileRequestError("INVALID_METHOD", `${method} is not allowed`);
  }
  const headers = normalizeHeaders(value.headers);
  const body = normalizeBody(value.body);
  if (body && (method === "GET" || method === "HEAD")) {
    throw profileRequestError("INVALID_BODY", `${method} requests cannot have a body`);
  }
  const timeoutMs = boundedInteger(
    value.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    100,
    MAX_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxResponseBytes = boundedInteger(
    value.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    1,
    MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const redirect = value.redirect ?? "follow";
  if (!["follow", "error"].includes(String(redirect))) {
    throw profileRequestError(
      "INVALID_REDIRECT",
      "redirect must be 'follow' or 'error'",
    );
  }
  const credentials = value.credentials ?? "include";
  if (!["include", "same-origin", "omit"].includes(String(credentials))) {
    throw profileRequestError(
      "INVALID_CREDENTIALS",
      "credentials must be 'include', 'same-origin', or 'omit'",
    );
  }
  return {
    method,
    headers,
    body,
    timeoutMs,
    maxResponseBytes,
    redirect: redirect as RequestRedirect,
    credentials: credentials as RequestCredentials,
  };
}

function normalizeHeaders(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw profileRequestError("INVALID_HEADERS", "headers must be an object");
  }
  const headers: Record<string, string> = {};
  let bytes = 0;
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim();
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw profileRequestError("INVALID_HEADERS", "header name is invalid");
    }
    if (FORBIDDEN_HEADERS.some((pattern) => pattern.test(name))) {
      throw profileRequestError(
        "FORBIDDEN_HEADER",
        `${name.toLowerCase()} is controlled by the Chromium Profile`,
      );
    }
    if (typeof rawValue !== "string" || /[\r\n]/.test(rawValue)) {
      throw profileRequestError(
        "INVALID_HEADERS",
        `${name.toLowerCase()} must be a single-line string`,
      );
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(rawValue);
    if (bytes > MAX_HEADER_BYTES) {
      throw profileRequestError("INVALID_HEADERS", "headers exceed 64 KiB");
    }
    headers[name] = rawValue;
  }
  return headers;
}

function normalizeBody(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw profileRequestError("INVALID_BODY", "body must use the encoded body contract");
  }
  const body = value as Record<string, unknown>;
  if (body.encoding !== "utf8" && body.encoding !== "base64") {
    throw profileRequestError("INVALID_BODY", "body encoding must be utf8 or base64");
  }
  if (typeof body.data !== "string") {
    throw profileRequestError("INVALID_BODY", "body data must be a string");
  }
  const decoded =
    body.encoding === "base64"
      ? Buffer.from(body.data, "base64")
      : Buffer.from(body.data, "utf8");
  if (decoded.byteLength > MAX_REQUEST_BYTES) {
    throw profileRequestError("REQUEST_TOO_LARGE", "request body exceeds 1 MiB");
  }
  return decoded;
}

async function readBoundedBody(response: Response, limit: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw profileRequestError(
          "RESPONSE_TOO_LARGE",
          `response body exceeds ${limit} bytes`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function publicResponseHeaders(headers: Headers) {
  const output: Array<[string, string]> = [];
  let bytes = 0;
  headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") return;
    if (name.toLowerCase() === "set-cookie2") return;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > MAX_RESPONSE_HEADER_BYTES) {
      throw profileRequestError(
        "RESPONSE_HEADERS_TOO_LARGE",
        "response headers exceed 64 KiB",
      );
    }
    output.push([name, value]);
  });
  return output;
}

function requestEventData(url: URL, method: string) {
  return {
    method,
    origin: url.origin,
    path: redactPath(url.pathname),
  };
}

function safeResponseUrl(value: string, fallback: URL) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    // Electron documents that Session.fetch Response.url can be inaccurate.
  }
  return fallback.toString();
}

function redactPath(pathname: string) {
  const sensitiveName =
    /pass(word)?|secret|token|authorization|cookie|otp|pin|credential|api[-_]?key/i;
  const segments = pathname.split("/");
  return segments
    .map((segment, index) => {
      if (sensitiveName.test(segments[index - 1] ?? "")) return "[redacted]";
      if (sensitiveName.test(segment) && segment.includes("=")) return "[redacted]";
      if (segment.length > 64 || /^[A-Za-z0-9_-]{32,}$/.test(segment)) {
        return "[redacted]";
      }
      return segment;
    })
    .join("/")
    .slice(0, 1_024);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw profileRequestError(
      "INVALID_ARGUMENT",
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

function normalizeRequestError(error: any, timedOut: boolean) {
  if (timedOut) {
    return {
      code: "EGO_PROFILE_REQUEST_TIMEOUT",
      error: profileRequestError("TIMEOUT", "request timed out"),
    };
  }
  const known = String(error?.message || "").match(/EGO_PROFILE_REQUEST_[A-Z_]+/)?.[0];
  if (known) return { code: known, error };
  return {
    code: "EGO_PROFILE_REQUEST_FAILED",
    error: profileRequestError("FAILED", "Chromium network request failed"),
  };
}

function profileRequestError(code: string, message: string) {
  return new Error(`EGO_PROFILE_REQUEST_${code}: ${message}`);
}
