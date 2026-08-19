// @ts-nocheck
import { evaluate } from "./cdp-eval.js";

const nativeFetch = globalThis.fetch?.bind(globalThis);

type SerializedProfileResponse = {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  redirected: boolean;
  headers: Array<[string, string]>;
  bodyBase64: string;
  bytes: number;
};

/**
 * Fetch text from Node with a browser-like User-Agent.
 * @param {string} url URL to fetch.
 * @param {{headers?: Record<string,string>, timeout?: number, method?: string, body?: any}} [options]
 * @returns {Promise<string>} Response body text.
 */
export async function serverFetch(url, options: any = {}) {
  if (!nativeFetch) {
    throw new Error("serverFetch requires globalThis.fetch");
  }
  const { timeout = 20.0, headers = {}, ...fetchOptions } = options;
  const response = await nativeFetch(url, {
    ...fetchOptions,
    // Each CLI heredoc is a short-lived process. Undici's default keep-alive
    // socket can otherwise hold the event loop open for roughly four seconds
    // after the script has already finished, making UFO feel slower than Ego
    // even when the browser work itself completed sooner.
    headers: {
      "User-Agent": "Mozilla/5.0",
      Connection: "close",
      ...headers,
    },
    signal: AbortSignal.timeout(timeout * 1000),
  });
  if (!response.ok) {
    throw new Error(
      `${fetchOptions.method || "GET"} ${url} failed: HTTP ${response.status}`,
    );
  }
  return response.text();
}

/**
 * Fetch text in the current browser page context.
 * @param {string} url URL to fetch. Relative URLs resolve against the current page.
 * @param {{headers?: Record<string,string>, timeout?: number, method?: string, body?: any}} [options]
 * @returns {Promise<string>} Response body text.
 */
export async function browserFetch(url, options: any = {}) {
  const { timeout = 20.0, ...fetchOptions } = options;
  const payload = JSON.stringify({ url, options: fetchOptions, timeout });
  return evaluate(`(async () => {
    const { url, options, timeout } = ${payload};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        throw new Error(\`\${options.method || "GET"} \${url} failed: HTTP \${response.status}\`);
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  })()`);
}

/**
 * Fetch through the selected Space's Chromium Session and Profile.
 * Timeout values are milliseconds, matching the page facade.
 */
export async function profileFetch(url: string, options: any = {}) {
  const ego = (globalThis as any).ego;
  if (!ego || typeof ego.profileRequest !== "function") {
    throw new Error("profileFetch requires ego.profileRequest");
  }
  const serialized = serializeProfileRequestOptions(options);
  const raw = (await ego.profileRequest(url, serialized)) as SerializedProfileResponse;
  return createProfileResponse(raw);
}

function serializeProfileRequestOptions(options: any) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Profile Request options must be an object");
  }
  const { body, json, headers: headersValue, ...rest } = options;
  if (body !== undefined && json !== undefined) {
    throw new TypeError("Profile Request accepts either body or json, not both");
  }
  const headers = normalizeProfileHeaders(headersValue);
  let encodedBody: { encoding: "utf8" | "base64"; data: string } | undefined;
  if (json !== undefined) {
    encodedBody = { encoding: "utf8", data: JSON.stringify(json) };
    if (!hasHeader(headers, "content-type")) {
      headers["content-type"] = "application/json";
    }
  } else if (typeof body === "string") {
    encodedBody = { encoding: "utf8", data: body };
  } else if (body instanceof URLSearchParams) {
    encodedBody = { encoding: "utf8", data: body.toString() };
    if (!hasHeader(headers, "content-type")) {
      headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    }
  } else if (body !== undefined) {
    const bytes = binaryBody(body);
    if (!bytes) {
      throw new TypeError(
        "Profile Request body must be a string, URLSearchParams, Buffer, ArrayBuffer, or typed array",
      );
    }
    encodedBody = {
      encoding: "base64",
      data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
        "base64",
      ),
    };
  }
  return {
    ...rest,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(encodedBody ? { body: encodedBody } : {}),
  };
}

function normalizeProfileHeaders(value: any) {
  if (value === undefined) return {} as Record<string, string>;
  const entries =
    typeof Headers !== "undefined" && value instanceof Headers
      ? [...value.entries()]
      : Array.isArray(value)
        ? value
        : value && typeof value === "object"
          ? Object.entries(value)
          : undefined;
  if (!entries) throw new TypeError("Profile Request headers must be an object");
  const output: Record<string, string> = {};
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError("Profile Request header entries must be [name, value]");
    }
    if (typeof entry[1] !== "string") {
      throw new TypeError(`Profile Request header ${String(entry[0])} must be a string`);
    }
    output[String(entry[0])] = entry[1];
  }
  return output;
}

function hasHeader(headers: Record<string, string>, name: string) {
  return Object.keys(headers).some(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
}

function binaryBody(value: any): Uint8Array | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function createProfileResponse(raw: SerializedProfileResponse) {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Number.isInteger(raw.status) ||
    typeof raw.bodyBase64 !== "string" ||
    !Array.isArray(raw.headers)
  ) {
    throw new Error("EGO_PROFILE_REQUEST_FAILED: invalid response from App");
  }
  const headerEntries = raw.headers.map(([name, value]) => [
    String(name),
    String(value),
  ] as [string, string]);
  const headerMap = Object.fromEntries(
    headerEntries.map(([name, value]) => [name.toLowerCase(), value]),
  );
  let decoded: Buffer | undefined;
  const bytes = () => (decoded ??= Buffer.from(raw.bodyBase64, "base64"));
  return Object.freeze({
    status: raw.status,
    statusText: String(raw.statusText ?? ""),
    ok: Boolean(raw.ok),
    url: String(raw.url ?? ""),
    redirected: Boolean(raw.redirected),
    bytes: Number(raw.bytes ?? 0),
    headers: () => ({ ...headerMap }),
    header: (name: string) => headerMap[String(name).toLowerCase()] ?? null,
    body: async () => Buffer.from(bytes()),
    text: async () => bytes().toString("utf8"),
    json: async () => JSON.parse(bytes().toString("utf8")),
  });
}
