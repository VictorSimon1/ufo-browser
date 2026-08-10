// @ts-nocheck
import { cdp } from "../cdp-eval.js";
import {
  ensureSession,
  subscribeBrowserEvent,
  subscribeSessionInvalidation,
} from "../browser-runtime.js";

type RouteOptions = { times?: number };
type RouteEntry = {
  matcher: string | RegExp | ((url: URL) => boolean);
  handler: (route: any, request: any) => unknown;
  remaining: number;
};
type RouteSession = {
  routes: RouteEntry[];
  unsubscribe: () => void;
};

const sessions = new Map<string, RouteSession>();

subscribeSessionInvalidation((sessionId) => {
  void disposeSession(sessionId);
});

/**
 * Intercept matching requests for the current page.
 * The handler receives a Playwright-style route with continue(), fulfill(),
 * abort(), and request(). Newer matching handlers run first.
 */
export async function route(
  matcher: string | RegExp | ((url: URL) => boolean),
  handler: (route: any, request: any) => unknown,
  options: RouteOptions = {},
) {
  validateMatcher(matcher, "page.route");
  if (typeof handler !== "function") {
    throw new TypeError("page.route requires a handler function");
  }
  const times = options.times ?? Number.POSITIVE_INFINITY;
  if (!(times === Number.POSITIVE_INFINITY || (Number.isInteger(times) && times > 0))) {
    throw new Error("page.route options.times must be a positive integer");
  }
  const sessionId = await ensureSession();
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      routes: [],
      unsubscribe: subscribeBrowserEvent(
        "Fetch.requestPaused",
        sessionId,
        (event) => void handlePausedRequest(sessionId, event),
      ),
    };
    sessions.set(sessionId, session);
    try {
      await cdp(
        "Fetch.enable",
        { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
        sessionId,
      );
    } catch (error) {
      session.unsubscribe();
      sessions.delete(sessionId);
      throw error;
    }
  }
  session.routes.push({ matcher, handler, remaining: times });
}

/** Remove matching route handlers from the current page. */
export async function unroute(matcher, handler = undefined) {
  validateMatcher(matcher, "page.unroute");
  const sessionId = await ensureSession();
  const session = sessions.get(sessionId);
  if (!session) return;
  session.routes = session.routes.filter(
    (entry) =>
      !sameMatcher(entry.matcher, matcher) ||
      (handler !== undefined && entry.handler !== handler),
  );
  if (session.routes.length === 0) await disposeSession(sessionId);
}

/** Remove every route handler from the current page. */
export async function unrouteAll() {
  const sessionId = await ensureSession();
  await disposeSession(sessionId);
}

async function handlePausedRequest(sessionId: string, event) {
  const session = sessions.get(sessionId);
  const params = event?.params || {};
  const requestId = params.requestId;
  if (!requestId) return;
  const request = createRequestFacade(params);
  const entry = [...(session?.routes || [])]
    .reverse()
    .find((candidate) => routeMatches(candidate.matcher, request.url()));
  if (!entry) {
    await continueRequest(sessionId, requestId).catch(() => undefined);
    return;
  }
  if (Number.isFinite(entry.remaining)) {
    entry.remaining -= 1;
    if (entry.remaining <= 0 && session) {
      session.routes = session.routes.filter((candidate) => candidate !== entry);
    }
  }
  const routeFacade = createRouteFacade(sessionId, requestId, request);
  try {
    await entry.handler(routeFacade, request);
  } catch (error) {
    console.error(`page.route handler failed for ${request.url()}:`, error);
  }
  if (!routeFacade.__handled()) {
    await routeFacade.continue();
  }
  if (session && session.routes.length === 0) {
    await disposeSession(sessionId);
  }
}

function createRouteFacade(sessionId, requestId, request) {
  let handled = false;
  const claim = () => {
    if (handled) throw new Error("route is already handled");
    handled = true;
  };
  return {
    request: () => request,
    continue: async (overrides: any = {}) => {
      claim();
      await continueRequest(sessionId, requestId, overrides);
    },
    fulfill: async (options: any = {}) => {
      claim();
      const headers = normalizeHeaders(options.headers);
      let body = options.body;
      if (options.json !== undefined) {
        body = JSON.stringify(options.json);
        if (!hasHeader(headers, "content-type")) {
          headers.push({ name: "content-type", value: "application/json; charset=utf-8" });
        }
      }
      if (options.contentType && !hasHeader(headers, "content-type")) {
        headers.push({ name: "content-type", value: String(options.contentType) });
      }
      const buffer = Buffer.isBuffer(body)
        ? body
        : Buffer.from(body === undefined ? "" : String(body));
      await cdp(
        "Fetch.fulfillRequest",
        {
          requestId,
          responseCode: Number(options.status ?? 200),
          responsePhrase: options.statusText,
          responseHeaders: headers,
          body: buffer.toString("base64"),
        },
        sessionId,
      );
    },
    abort: async (errorCode = "Failed") => {
      claim();
      await cdp(
        "Fetch.failRequest",
        { requestId, errorReason: String(errorCode) },
        sessionId,
      );
    },
    __handled: () => handled,
  };
}

function continueRequest(sessionId, requestId, overrides: any = {}) {
  const params: any = { requestId };
  if (overrides.url !== undefined) params.url = String(overrides.url);
  if (overrides.method !== undefined) params.method = String(overrides.method);
  if (overrides.postData !== undefined) {
    params.postData = Buffer.from(String(overrides.postData)).toString("base64");
  }
  if (overrides.headers !== undefined) {
    params.headers = normalizeHeaders(overrides.headers);
  }
  return cdp("Fetch.continueRequest", params, sessionId);
}

function createRequestFacade(params) {
  const request = params.request || {};
  const headers = Object.fromEntries(
    Object.entries(request.headers || {}).map(([name, value]) => [
      String(name).toLowerCase(),
      String(value),
    ]),
  );
  return {
    url: () => request.url || "",
    method: () => request.method || "",
    headers: () => ({ ...headers }),
    postData: () => request.postData ?? null,
    resourceType: () => String(params.resourceType || "").toLowerCase(),
    isNavigationRequest: () => Boolean(params.networkId && params.resourceType === "Document"),
  };
}

function routeMatches(matcher, url: string) {
  if (typeof matcher === "string") {
    return matcher.includes("*") ? globToRegExp(matcher).test(url) : matcher === url;
  }
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(url);
  }
  return Boolean(matcher(new URL(url)));
}

function globToRegExp(glob: string) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function normalizeHeaders(headers = {}) {
  if (Array.isArray(headers)) {
    return headers.map(({ name, value }) => ({
      name: String(name),
      value: String(value),
    }));
  }
  return Object.entries(headers || {}).map(([name, value]) => ({
    name: String(name),
    value: String(value),
  }));
}

function hasHeader(headers, name) {
  return headers.some((header) => header.name.toLowerCase() === name);
}

function validateMatcher(matcher, helperName) {
  if (
    typeof matcher !== "string" &&
    !(matcher instanceof RegExp) &&
    typeof matcher !== "function"
  ) {
    throw new TypeError(
      `${helperName} expects a string, RegExp, or predicate matcher`,
    );
  }
}

function sameMatcher(left, right) {
  if (left === right) return true;
  if (left instanceof RegExp && right instanceof RegExp) {
    return left.source === right.source && left.flags === right.flags;
  }
  return false;
}

async function disposeSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  session.unsubscribe();
  await cdp("Fetch.disable", {}, sessionId).catch(() => undefined);
}
