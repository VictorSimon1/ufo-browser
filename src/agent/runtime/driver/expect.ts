// @ts-nocheck
import { state } from "../state.js";
import { TimeoutError } from "../errors.js";

type ExpectOptions = { timeout?: number };

export function expectTarget(target: any): any {
  const positive = matcherFacade(target, false);
  Object.defineProperty(positive, "not", {
    enumerable: true,
    get: () => matcherFacade(target, true),
  });
  return positive;
}

function matcherFacade(target, negated: boolean) {
  return {
    toHaveText: (expected, options: ExpectOptions = {}) =>
      pollExpectation(
        "toHaveText",
        target,
        expected,
        options,
        () => requiredMethod(target, "innerText")(),
        textMatches,
        negated,
      ),
    toBeEnabled: (options: ExpectOptions = {}) =>
      pollExpectation(
        "toBeEnabled",
        target,
        true,
        options,
        () => requiredMethod(target, "isEnabled")(),
        Object.is,
        negated,
      ),
    toBeVisible: (options: ExpectOptions = {}) =>
      pollExpectation(
        "toBeVisible",
        target,
        true,
        options,
        () => requiredMethod(target, "isVisible")(),
        Object.is,
        negated,
      ),
    toHaveCount: (expected, options: ExpectOptions = {}) =>
      pollExpectation(
        "toHaveCount",
        target,
        Number(expected),
        options,
        () => requiredMethod(target, "count")(),
        Object.is,
        negated,
      ),
    toHaveURL: (expected, options: ExpectOptions = {}) =>
      pollExpectation(
        "toHaveURL",
        target,
        expected,
        options,
        () => requiredMethod(target, "url")(),
        urlMatches,
        negated,
      ),
    toHaveValue: (expected, options: ExpectOptions = {}) =>
      pollExpectation(
        "toHaveValue",
        target,
        expected,
        options,
        () => requiredMethod(target, "inputValue")(),
        textMatches,
        negated,
      ),
  };
}

async function pollExpectation(
  matcherName,
  target,
  expected,
  options,
  readActual,
  matches,
  negated,
) {
  const timeout = finiteTimeout(options.timeout ?? state.defaultTimeout);
  const deadline = state.now() + timeout;
  let actual;
  let lastError;
  let attempts = 0;
  do {
    attempts += 1;
    try {
      actual = await readActual();
      const matched = Boolean(matches(actual, expected));
      if (negated ? !matched : matched) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - state.now();
    if (remaining <= 0) break;
    await state.sleep(Math.min(50, remaining));
  } while (state.now() <= deadline);

  const locator = target?.selector || (typeof target?.url === "function" ? "page" : "value");
  const detail = lastError
    ? `last error: ${lastError?.message || lastError}`
    : `expected ${formatValue(expected)}, received ${formatValue(actual)}`;
  throw new TimeoutError(
    `expect(${locator}).${negated ? "not." : ""}${matcherName} timed out after ${timeout}ms (${attempts} attempts): ${detail}`,
    { timeout, locator },
  );
}

function requiredMethod(target, method) {
  if (!target || typeof target[method] !== "function") {
    throw new TypeError(`expect target does not support ${method}()`);
  }
  return target[method].bind(target);
}

function textMatches(actual, expected) {
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(String(actual ?? ""));
  }
  return String(actual ?? "") === String(expected ?? "");
}

function urlMatches(actual, expected) {
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(String(actual ?? ""));
  }
  if (typeof expected === "function") return Boolean(expected(new URL(actual)));
  return String(actual ?? "") === String(expected ?? "");
}

function finiteTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new TypeError("expect timeout must be a non-negative number");
  }
  return timeout;
}

function formatValue(value) {
  if (value instanceof RegExp) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
