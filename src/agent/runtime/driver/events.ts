// @ts-nocheck
import { cdp } from "../cdp-eval.js";
import {
  ensureSession,
  subscribeBrowserEvent,
} from "../browser-runtime.js";
import { state } from "../state.js";
import { TimeoutError } from "../errors.js";

const subscriptions = new Map<any, Map<string, Set<() => void>>>();
const requests = new Map<string, any>();
const MAX_TRACKED_REQUESTS = 4096;

const EVENT_METHODS = {
  console: ["Runtime.consoleAPICalled"],
  pageerror: ["Runtime.exceptionThrown"],
  request: ["Network.requestWillBeSent"],
  requestfailed: ["Network.requestWillBeSent", "Network.loadingFailed"],
};

export function supportsPageEvent(eventName) {
  return Boolean(EVENT_METHODS[eventName]);
}

export function onPageEvent(eventName, listener, subscriptionOwner = listener) {
  validate(eventName, listener);
  const methods = EVENT_METHODS[eventName];
  const retainsNetwork = isNetworkEvent(eventName);
  if (retainsNetwork) state.networkDomainRetainers += 1;
  const unsubs = methods.map((method) =>
    subscribeBrowserEvent(method, undefined, (event) => {
      const facade = eventFacade(eventName, event);
      if (facade === undefined) return;
      try {
        const result = listener(facade);
        if (result && typeof result.then === "function") {
          void result.catch((error) => {
            console.error(
              `page.on(${JSON.stringify(eventName)}) listener failed:`,
              error,
            );
          });
        }
      } catch (error) {
        console.error(`page.on(${JSON.stringify(eventName)}) listener failed:`, error);
      }
    }),
  );
  let byEvent = subscriptions.get(subscriptionOwner);
  if (!byEvent) {
    byEvent = new Map();
    subscriptions.set(subscriptionOwner, byEvent);
  }
  const set = byEvent.get(eventName) ?? new Set();
  let active = true;
  const unsubscribe = () => {
    if (!active) return;
    active = false;
    for (const remove of unsubs) remove();
    if (retainsNetwork) {
      state.networkDomainRetainers = Math.max(
        0,
        state.networkDomainRetainers - 1,
      );
    }
    set.delete(unsubscribe);
    if (set.size === 0) byEvent.delete(eventName);
    if (byEvent.size === 0) subscriptions.delete(subscriptionOwner);
  };
  set.add(unsubscribe);
  byEvent.set(eventName, set);
  void enableDomain(eventName).catch((error) => {
    console.error(`page.on(${JSON.stringify(eventName)}) could not enable events:`, error);
  });
  return unsubscribe;
}

export function offPageEvent(eventName, listener) {
  const set = subscriptions.get(listener)?.get(eventName);
  if (!set) return;
  for (const unsubscribe of [...set]) unsubscribe();
}

export function oncePageEvent(eventName, listener) {
  let unsubscribe = () => undefined;
  unsubscribe = onPageEvent(
    eventName,
    (value) => {
      unsubscribe();
      listener(value);
    },
    listener,
  );
  return unsubscribe;
}

export async function waitForPageEvent(
  eventName,
  predicateOrOptions: any = {},
  maybeOptions: any = {},
) {
  if (!EVENT_METHODS[eventName]) return null;
  const predicate =
    typeof predicateOrOptions === "function" ? predicateOrOptions : () => true;
  const options =
    typeof predicateOrOptions === "function" ? maybeOptions : predicateOrOptions;
  const timeout = finiteTimeout(options?.timeout ?? state.defaultTimeout);
  let unsubscribe = () => undefined;
  let timer;
  const promise = new Promise((resolve, reject) => {
    unsubscribe = onPageEvent(eventName, (value) => {
      let matched;
      try {
        matched = predicate(value);
      } catch (error) {
        clearTimeout(timer);
        unsubscribe();
        reject(error);
        return;
      }
      if (!matched) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    });
    if (timeout > 0) {
      timer = setTimeout(() => {
        unsubscribe();
        reject(
          new TimeoutError(
            `page.waitForEvent(${JSON.stringify(eventName)}) timed out after ${timeout}ms`,
            { timeout },
          ),
        );
      }, timeout);
    }
  });
  await enableDomain(eventName);
  return promise;
}

function eventFacade(eventName, event) {
  const params = event?.params || {};
  const sessionId = event?.sessionId || "root";
  if (eventName === "console") {
    const args = params.args || [];
    return {
      type: () => String(params.type || "log"),
      text: () =>
        args
          .map((arg) =>
            Object.prototype.hasOwnProperty.call(arg || {}, "value")
              ? String(arg.value)
              : String(arg?.description || arg?.unserializableValue || ""),
          )
          .join(" "),
      args: () => args.map((arg) => ({ ...arg })),
      location: () => ({
        url: params.stackTrace?.callFrames?.[0]?.url || "",
        lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber,
        columnNumber: params.stackTrace?.callFrames?.[0]?.columnNumber,
      }),
    };
  }
  if (eventName === "pageerror") {
    const details = params.exceptionDetails || {};
    const description =
      details.exception?.description ||
      details.exception?.value ||
      details.text ||
      "Page error";
    const error = new Error(String(description).split("\n")[0]);
    error.name = details.exception?.className || "Error";
    error.stack = String(description);
    return error;
  }
  if (eventName === "request") {
    const request = requestFacade(params, undefined);
    rememberRequest(`${sessionId}:${params.requestId}`, request.__info);
    return request;
  }
  if (eventName === "requestfailed") {
    if (event?.method === "Network.requestWillBeSent") {
      const request = requestFacade(params, undefined);
      rememberRequest(`${sessionId}:${params.requestId}`, request.__info);
      return undefined;
    }
    const requestKey = `${sessionId}:${params.requestId}`;
    const info = requests.get(requestKey) || {
      url: "",
      method: "",
      headers: {},
      postData: null,
      resourceType: "",
    };
    // One CDP event can be observed by page.on(), page.once(), and
    // page.waitForEvent() at the same time. Keep the metadata until the whole
    // synchronous subscriber dispatch has finished so every listener sees
    // the same request facade.
    queueMicrotask(() => {
      if (requests.get(requestKey) === info) requests.delete(requestKey);
    });
    return requestFacade(
      { requestId: params.requestId, request: info, type: info.resourceType },
      { errorText: params.errorText || "Failed", canceled: Boolean(params.canceled) },
      true,
    );
  }
}

function requestFacade(params, failure = undefined, normalized = false) {
  const raw = params.request || {};
  const info = normalized
    ? raw
    : {
        url: raw.url || "",
        method: raw.method || "",
        headers: normalizeHeaders(raw.headers),
        postData: raw.postData ?? null,
        resourceType: String(params.type || "").toLowerCase(),
      };
  const facade: any = {
    url: () => info.url || "",
    method: () => info.method || "",
    headers: () => ({ ...(info.headers || {}) }),
    postData: () => info.postData ?? null,
    resourceType: () => info.resourceType || "",
    failure: () => (failure ? { ...failure } : null),
  };
  Object.defineProperty(facade, "__info", { value: info });
  return facade;
}

async function enableDomain(eventName) {
  await ensureSession();
  if (eventName === "console" || eventName === "pageerror") {
    await cdp("Runtime.enable");
  } else {
    await cdp("Network.enable");
  }
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([name, value]) => [
      String(name).toLowerCase(),
      String(value),
    ]),
  );
}

function rememberRequest(key, info) {
  requests.delete(key);
  requests.set(key, info);
  while (requests.size > MAX_TRACKED_REQUESTS) {
    const oldest = requests.keys().next().value;
    if (oldest === undefined) break;
    requests.delete(oldest);
  }
}

function isNetworkEvent(eventName) {
  return eventName === "request" || eventName === "requestfailed";
}

function validate(eventName, listener) {
  if (!EVENT_METHODS[eventName]) {
    throw new Error(
      `page.on supports ${Object.keys(EVENT_METHODS).map((name) => JSON.stringify(name)).join(", ")}, got ${JSON.stringify(eventName)}`,
    );
  }
  if (typeof listener !== "function") {
    throw new TypeError("page.on requires a listener function");
  }
}

function finiteTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new TypeError("page.waitForEvent timeout must be non-negative");
  }
  return timeout;
}
