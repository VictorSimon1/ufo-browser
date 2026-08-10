// @ts-nocheck
import { cdp, runtimeValue } from "../cdp-eval.js";
import {
  browserRefMap,
  ensureRefMapForRef,
  refreshStaleRef,
} from "../ref-state.js";
import { parseRef } from "../ref-map.js";
import {
  ElementResolutionError,
  resolveElementObjectId,
} from "../element-resolver.js";
import {
  browserIframeSessions,
  ensureIframeSession,
} from "../browser-runtime.js";
import { state } from "../state.js";
import { queryAllExpression } from "../locator-query.js";

const CLICK_ACTIONABILITY_SOURCE = `async function(){
  if (!this || this.nodeType !== 1) return { ok: false, reason: "not-an-element" };
  if (!this.isConnected) return { ok: false, reason: "detached" };
  const view = this.ownerDocument?.defaultView || window;
  if (typeof this.scrollIntoViewIfNeeded === "function") this.scrollIntoViewIfNeeded(true);
  else this.scrollIntoView({ block: "center", inline: "center" });
  const visible = () => {
    if (typeof this.checkVisibility === "function" && !this.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const style = view.getComputedStyle(this);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = this.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  if (!visible()) return { ok: false, reason: "not-visible" };
  const control = this.tagName === "LABEL" && this.control ? this.control : this;
  if (control.getAttribute?.("aria-disabled") === "true" || ("disabled" in control && control.disabled) || control.closest?.("fieldset[disabled]")) {
    return { ok: false, reason: "disabled" };
  }
  const first = this.getBoundingClientRect();
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    view.requestAnimationFrame(finish);
    view.setTimeout(finish, 32);
  });
  if (!visible()) return { ok: false, reason: "not-visible" };
  const rect = this.getBoundingClientRect();
  if (Math.abs(first.x - rect.x) > 0.25 || Math.abs(first.y - rect.y) > 0.25 || Math.abs(first.width - rect.width) > 0.25 || Math.abs(first.height - rect.height) > 0.25) {
    return { ok: false, reason: "unstable" };
  }
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  let hit = this.ownerDocument.elementFromPoint(x, y);
  while (hit?.shadowRoot) hit = hit.shadowRoot.elementFromPoint(x, y) || hit;
  if (!hit || !(hit === this || this.contains(hit))) {
    return { ok: false, reason: "intercepted", x, y };
  }
  return { ok: true, x, y };
}`;

const EDITABLE_ACTIONABILITY_SOURCE = `function(){
  const target = this?.tagName === "LABEL" && this.control ? this.control : this;
  if (!target || target.nodeType !== 1) return { ok: false, reason: "not-an-element" };
  if (!target.isConnected) return { ok: false, reason: "detached" };
  const view = target.ownerDocument?.defaultView || window;
  if (typeof target.checkVisibility === "function" && !target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return { ok: false, reason: "not-visible" };
  const style = view.getComputedStyle(target);
  const rect = target.getBoundingClientRect();
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || rect.width === 0 || rect.height === 0) return { ok: false, reason: "not-visible" };
  if (target.getAttribute("aria-disabled") === "true" || ("disabled" in target && target.disabled) || target.closest("fieldset[disabled]")) return { ok: false, reason: "disabled" };
  const tag = target.tagName;
  if ((tag === "INPUT" || tag === "TEXTAREA") && target.readOnly) return { ok: false, reason: "readonly" };
  if (tag === "INPUT" && ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(target.type)) return { ok: false, reason: "not-editable" };
  if (!target.isContentEditable && tag !== "INPUT" && tag !== "TEXTAREA") return { ok: false, reason: "not-editable" };
  return { ok: true };
}`;

/**
 * Resolve any selector form to a CDP Runtime objectId handle.
 * Accepts @ref / ref=N, loc=css:/loc=role:/loc=href:, xpath=, and raw CSS —
 * the same surface as the pointer/observe helpers, via the unified resolver.
 * Refreshes the RefMap on demand when the input is a ref and the map is empty.
 * @param {string} selectorOrRef Selector or ref string.
 * @returns {Promise<{objectId: string, sessionId?: string}>}
 */
export async function resolveHandle(selectorOrRef) {
  const frameLocator = parseFrameLocatorSelector(selectorOrRef);
  if (frameLocator) {
    return resolveFrameElementHandle(frameLocator);
  }
  await ensureRefMapForRef(selectorOrRef);
  const refId = parseRef(selectorOrRef);
  if (refId && browserRefMap.get(refId)?.stale) {
    await refreshStaleRef(selectorOrRef);
  }
  try {
    return await resolveHandleOnce(selectorOrRef);
  } catch (error) {
    if (!refId || !(await refreshStaleRef(selectorOrRef))) throw error;
    return resolveHandleOnce(selectorOrRef);
  }
}

async function resolveHandleOnce(selectorOrRef) {
  const refId = String(selectorOrRef || "").trim().replace(/^@|^ref=/, "");
  const frameId = browserRefMap.get(refId)?.frameId;
  if (frameId) await ensureIframeSession(frameId);
  return resolveElementObjectId(
    { sendRaw: cdp },
    undefined,
    browserRefMap,
    selectorOrRef,
    browserIframeSessions(),
  );
}

export function frameLocatorSelector(frame, child) {
  return `internal:frame:${encodeURIComponent(JSON.stringify({ frame, child }))}`;
}

export function parseFrameLocatorSelector(selector) {
  const prefix = "internal:frame:";
  if (typeof selector !== "string" || !selector.startsWith(prefix)) return null;
  try {
    const value = JSON.parse(decodeURIComponent(selector.slice(prefix.length)));
    if (typeof value?.frame !== "string" || typeof value?.child !== "string") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function evaluateFrameElements(selector, body, awaitPromise = false) {
  const frameLocator = parseFrameLocatorSelector(selector);
  if (!frameLocator) return null;
  return withFrameExecution(frameLocator.frame, async (frame) => {
    const query = queryAllExpression(
      frameLocator.child,
      frame.sessionId ? "document" : "this.contentDocument",
    );
    const source = frame.sessionId
      ? `(() => { const elements = ${query}; ${body} })()`
      : `function(){ const elements = ${query}; ${body} }`;
    const response = frame.sessionId
      ? await cdp(
          "Runtime.evaluate",
          {
            expression: source,
            returnByValue: true,
            awaitPromise,
          },
          frame.sessionId,
        )
      : await cdp(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: source,
            objectId: frame.objectId,
            returnByValue: true,
            awaitPromise,
          },
          frame.parentSessionId,
        );
    return runtimeValue(response, source);
  });
}

async function resolveFrameElementHandle(frameLocator) {
  return withFrameExecution(frameLocator.frame, async (frame) => {
    const query = queryAllExpression(
      frameLocator.child,
      frame.sessionId ? "document" : "this.contentDocument",
    );
    const body = `
      const elements = ${query};
      if (elements.length > 1) throw new Error(${JSON.stringify(`Locator ${frameLocator.child} matched `)} + elements.length + " elements");
      return elements[0] || null;
    `;
    const source = frame.sessionId
      ? `(() => { ${body} })()`
      : `function(){ ${body} }`;
    const response = frame.sessionId
      ? await cdp(
          "Runtime.evaluate",
          {
            expression: source,
            returnByValue: false,
            awaitPromise: false,
            objectGroup: "ego-browser-frame",
          },
          frame.sessionId,
        )
      : await cdp(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: source,
            objectId: frame.objectId,
            returnByValue: false,
            awaitPromise: false,
            objectGroup: "ego-browser-frame",
          },
          frame.parentSessionId,
        );
    if (response.exceptionDetails || response.result?.subtype === "error") {
      const message =
        response.exceptionDetails?.exception?.description ||
        response.exceptionDetails?.text ||
        "frame locator evaluation failed";
      const count = /matched (\d+) elements/.exec(message);
      throw new ElementResolutionError(
        message,
        count && Number(count[1]) > 1 ? "permanent" : "transient",
      );
    }
    const objectId = response.result?.objectId;
    if (!objectId) {
      throw new ElementResolutionError(
        `Frame locator ${frameLocator.child} matched 0 elements`,
        "transient",
      );
    }
    return {
      objectId,
      sessionId: frame.sessionId || frame.parentSessionId,
      offsetX: frame.sessionId ? 0 : frame.offsetX,
      offsetY: frame.sessionId ? 0 : frame.offsetY,
    };
  });
}

async function withFrameExecution(frameSelector, operation) {
  const handle = await resolveHandle(frameSelector);
  try {
    const [description, bounds] = await Promise.all([
      cdp("DOM.describeNode", { objectId: handle.objectId }, handle.sessionId),
      cdp(
        "Runtime.callFunctionOn",
        {
          functionDeclaration:
            "function(){const rect=this.getBoundingClientRect();return {x:rect.x,y:rect.y};}",
          objectId: handle.objectId,
          returnByValue: true,
          awaitPromise: false,
        },
        handle.sessionId,
      ),
    ]);
    const frameId = description.node?.frameId;
    let sessionId;
    if (frameId) {
      try {
        sessionId = await ensureIframeSession(frameId);
      } catch (error) {
        if (!/target|frame|session.*not found|No target/i.test(String(error))) {
          throw error;
        }
      }
    }
    const point = bounds.result?.value || {};
    return await operation({
      objectId: handle.objectId,
      parentSessionId: handle.sessionId,
      sessionId,
      offsetX: Number(handle.offsetX || 0) + Number(point.x || 0),
      offsetY: Number(handle.offsetY || 0) + Number(point.y || 0),
    });
  } finally {
    await releaseHandle(handle.objectId, handle.sessionId);
  }
}

/**
 * Release a Runtime objectId handle. Best-effort: swallows "already gone"
 * errors (stale handle, lost session, destroyed context).
 * @param {string} objectId Runtime remote object id to release.
 * @param {string} [sessionId] Session that owns the handle.
 * @returns {Promise<void>}
 */
export async function releaseHandle(objectId, sessionId) {
  if (!objectId) return;
  try {
    await cdp("Runtime.releaseObject", { objectId }, sessionId);
  } catch {
    // Handle/session already invalid; releasing is best-effort.
  }
}

/**
 * Resolve a handle, run fn(handle), then release the handle — even if fn throws.
 * @param {string} selectorOrRef Selector or ref string.
 * @param {(handle: {objectId: string, sessionId?: string}) => Promise<any>} fn Callback bound to the resolved handle.
 * @returns {Promise<any>} Whatever fn returns.
 */
export async function withHandle(selectorOrRef, fn) {
  const handle = await resolveHandle(selectorOrRef);
  try {
    return await fn(handle);
  } finally {
    await releaseHandle(handle.objectId, handle.sessionId);
  }
}

/**
 * Resolve an element and wait until a user action can actually affect it.
 * Successful callers own the returned handle and must release it.
 * @param {string} selectorOrRef Selector or ref string.
 * @param {"click"|"editable"} action Required actionability state.
 * @param {{timeout?:number, operation?:string}} [options]
 * @returns {Promise<{objectId:string,sessionId?:string,x?:number,y?:number}>}
 */
export async function waitForActionableHandle(
  selectorOrRef,
  action,
  options: { timeout?: number; operation?: string } = {},
) {
  const timeout = options.timeout ?? state.defaultTimeout;
  const deadline = state.now() + Math.max(0, timeout);
  const operation = options.operation || action;
  const source =
    action === "click"
      ? CLICK_ACTIONABILITY_SOURCE
      : action === "editable"
        ? EDITABLE_ACTIONABILITY_SOURCE
        : null;
  if (!source) throw new Error(`unsupported actionability state: ${action}`);
  let lastReason = "not-ready";
  do {
    let handle;
    try {
      handle = await resolveHandle(selectorOrRef);
      const response = await cdp(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: source,
          objectId: handle.objectId,
          returnByValue: true,
          awaitPromise: action === "click",
        },
        handle.sessionId,
      );
      const value = runtimeValue(response, source) || {};
      if (value.ok) {
        return {
          ...handle,
          x: Number(value.x || 0) + Number(handle.offsetX || 0),
          y: Number(value.y || 0) + Number(handle.offsetY || 0),
        };
      }
      lastReason = value.reason || lastReason;
      if (value.reason === "detached" && parseRef(selectorOrRef)) {
        await refreshStaleRef(selectorOrRef);
      }
    } catch (error) {
      if (
        !(error instanceof ElementResolutionError) ||
        error.kind !== "transient"
      ) {
        if (handle) await releaseHandle(handle.objectId, handle.sessionId);
        throw error;
      }
      lastReason = error.message;
    }
    if (handle) await releaseHandle(handle.objectId, handle.sessionId);
    const remaining = deadline - state.now();
    if (remaining <= 0) break;
    await state.sleep(Math.min(16, remaining));
  } while (state.now() <= deadline);
  throw new Error(
    `${operation}: element is not actionable (${lastReason}): ${JSON.stringify(selectorOrRef)}`,
  );
}

/**
 * Resolve an element and call a function on it via Runtime.callFunctionOn,
 * with the element bound as `this`. The resolved handle is released afterward;
 * the returned objectId is already freed and must not be reused.
 * @param {string} selectorOrRef Selector or ref string.
 * @param {string} functionDeclaration Function source whose `this` is the element.
 * @param {Array<unknown>} [args=[]] Arguments passed by value.
 * @returns {Promise<{result: any, objectId: string, sessionId?: string}>}
 */
export async function resolveAndCall(
  selectorOrRef,
  functionDeclaration,
  args = [],
) {
  return withHandle(selectorOrRef, async ({ objectId, sessionId }) => {
    const result = await cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration,
        objectId,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    );
    if (result.exceptionDetails || result.result?.subtype === "error") {
      runtimeValue(result, functionDeclaration);
    }
    return { result, objectId, sessionId };
  });
}
