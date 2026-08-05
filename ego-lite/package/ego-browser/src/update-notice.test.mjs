import test from "node:test";
import assert from "node:assert/strict";

import {
  NOTICE_PREFIX,
  composeNotice,
  emitUpdateNotice,
  noticeSuppressed,
  updateNoticeLine,
} from "../dist/src/update-notice.js";

// composeNotice -------------------------------------------------------------

test("composeNotice returns null when there is nothing to report", () => {
  assert.equal(composeNotice(null), null);
  assert.equal(composeNotice(undefined), null);
  assert.equal(
    composeNotice({ currentVersion: "0.4.3.0", updateAvailable: false }),
    null,
  );
});

test("composeNotice renders an available update with prefix, versions, and hint", () => {
  const line = composeNotice({
    currentVersion: "0.4.3.0",
    updateAvailable: true,
    latestVersion: "0.4.4.0",
  });
  assert.ok(line.startsWith(NOTICE_PREFIX));
  assert.match(line, /ego lite 0\.4\.4\.0 is available/);
  assert.match(line, /current 0\.4\.3\.0/);
  assert.match(line, /run: ego-browser upgrade in your shell/);
  assert.match(line, /re-read the ego-browser skill/);
});

test("composeNotice marks a mandatory update as required", () => {
  const line = composeNotice({
    currentVersion: "0.4.3.0",
    updateAvailable: true,
    latestVersion: "0.4.4.0",
    mandatory: true,
  });
  assert.match(line, /is required/);
});

test("composeNotice falls back to a generic phrase without a usable latest version", () => {
  assert.match(
    composeNotice({ currentVersion: "0.4.3.0", updateAvailable: true }),
    /an ego lite update is available/,
  );
  // A non-string latestVersion is untrusted bridge input; treat it as absent.
  assert.match(
    composeNotice({
      currentVersion: "0.4.3.0",
      updateAvailable: true,
      latestVersion: 42,
    }),
    /an ego lite update is available/,
  );
});

test("composeNotice treats blank version strings as absent", () => {
  // The updater can report updateAvailable before the version strings resolve, so ""
  // is a realistic bridge value: a blank currentVersion is not usable -> null.
  assert.equal(
    composeNotice({
      currentVersion: "",
      updateAvailable: true,
      latestVersion: "0.4.4.0",
    }),
    null,
  );
  assert.equal(
    composeNotice({ currentVersion: "   ", updateAvailable: true }),
    null,
  );
  // A blank latestVersion degrades to the generic phrase, never "ego lite  is available".
  const line = composeNotice({
    currentVersion: "0.4.3.0",
    updateAvailable: true,
    latestVersion: "",
  });
  assert.match(line, /an ego lite update is available/);
  assert.doesNotMatch(line, / {2}/); // no stray double space from a blank version
});

test("composeNotice requires a boolean-true updateAvailable / mandatory", () => {
  // A truthy non-boolean (e.g. a stringified "false" or a numeric flag) must not count
  // as an update — only the literal boolean true does.
  assert.equal(
    composeNotice({ currentVersion: "0.4.3.0", updateAvailable: "false" }),
    null,
  );
  assert.equal(
    composeNotice({ currentVersion: "0.4.3.0", updateAvailable: 1 }),
    null,
  );
  // Likewise a truthy non-boolean mandatory must not flip the wording to "is required".
  const line = composeNotice({
    currentVersion: "0.4.3.0",
    updateAvailable: true,
    latestVersion: "0.4.4.0",
    mandatory: "no",
  });
  assert.match(line, /is available/);
  assert.doesNotMatch(line, /is required/);
});

test("composeNotice rejects input without a usable current version", () => {
  assert.equal(composeNotice({ updateAvailable: true }), null);
});

// noticeSuppressed ----------------------------------------------------------

test("noticeSuppressed is false with a clean env", () => {
  assert.equal(noticeSuppressed({}), false);
});

test("noticeSuppressed honors the opt-out var and CI", () => {
  assert.equal(noticeSuppressed({ EGO_BROWSER_NO_UPDATE_NOTIFIER: "1" }), true);
  assert.equal(noticeSuppressed({ CI: "true" }), true);
});

// updateNoticeLine (the composed entry the emit point calls) ----------------

test("updateNoticeLine surfaces a line when the source reports an update", async () => {
  const source = async () => ({
    currentVersion: "0.4.3.0",
    updateAvailable: true,
    latestVersion: "0.4.4.0",
  });
  const line = await updateNoticeLine({ source, env: {} });
  assert.ok(line.startsWith(NOTICE_PREFIX));
});

test("updateNoticeLine is null when the source reports no update", async () => {
  assert.equal(
    await updateNoticeLine({ source: async () => null, env: {} }),
    null,
  );
  assert.equal(
    await updateNoticeLine({
      source: async () => ({
        currentVersion: "0.4.3.0",
        updateAvailable: false,
      }),
      env: {},
    }),
    null,
  );
});

test("updateNoticeLine is null and skips the source when suppressed", async () => {
  let called = false;
  const source = async () => {
    called = true;
    return {
      currentVersion: "0.4.3.0",
      updateAvailable: true,
      latestVersion: "0.4.4.0",
    };
  };
  assert.equal(await updateNoticeLine({ source, env: { CI: "true" } }), null);
  assert.equal(called, false);
});

test("updateNoticeLine swallows a throwing source", async () => {
  const source = async () => {
    throw new Error("bridge unavailable");
  };
  assert.equal(await updateNoticeLine({ source, env: {} }), null);
});

test("updateNoticeLine gives up (null) when the source never resolves", async () => {
  // A stuck bridge must not leave the check pending forever; the timeout bounds it.
  // The timeout timer is unref'd (so it can never keep a real process alive on its own),
  // which means it only fires while the loop is otherwise busy — exactly a live run's
  // condition. This ref'd interval reproduces that busy loop so the unref'd timeout can
  // fire; without it the test process would drain before the timeout and the await would
  // hang ("Promise resolution is still pending but the event loop has already resolved").
  const keepLoopAlive = setInterval(() => {}, 5);
  try {
    const source = () => new Promise(() => {});
    assert.equal(
      await updateNoticeLine({ source, env: {}, timeoutMs: 10 }),
      null,
    );
  } finally {
    clearInterval(keepLoopAlive);
  }
});

// emitUpdateNotice (the installEgoSdk wiring point) --------------------------

function collect() {
  const lines = [];
  return { lines, emit: (line) => lines.push(line) };
}

// emitUpdateNotice is fire-and-forget: flush pending microtasks before asserting.
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("emitUpdateNotice hands one line to emit when the bridge reports an update", async () => {
  const ego = {
    getBrowserVersion: async () => ({
      currentVersion: "0.4.3.0",
      updateAvailable: true,
      latestVersion: "0.4.4.0",
    }),
  };
  const { lines, emit } = collect();
  emitUpdateNotice(ego, emit, {});
  await flushMicrotasks();
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(NOTICE_PREFIX));
  assert.match(lines[0], /run: ego-browser upgrade in your shell/);
});

test("emitUpdateNotice stays silent when there is no update", async () => {
  const ego = {
    getBrowserVersion: async () => ({
      currentVersion: "0.4.3.0",
      updateAvailable: false,
    }),
  };
  const { lines, emit } = collect();
  emitUpdateNotice(ego, emit, {});
  await flushMicrotasks();
  assert.equal(lines.length, 0);
});

test("emitUpdateNotice stays silent when the bridge method is missing (older build)", async () => {
  const { lines, emit } = collect();
  emitUpdateNotice({}, emit, {});
  await flushMicrotasks();
  assert.equal(lines.length, 0);
});

test("emitUpdateNotice stays silent when there is no ego bridge at all", async () => {
  const { lines, emit } = collect();
  emitUpdateNotice(null, emit, {});
  await flushMicrotasks();
  assert.equal(lines.length, 0);
});

test("emitUpdateNotice is suppressed in CI even when an update is available", async () => {
  const ego = {
    getBrowserVersion: async () => ({
      currentVersion: "0.4.3.0",
      updateAvailable: true,
      latestVersion: "0.4.4.0",
    }),
  };
  const { lines, emit } = collect();
  emitUpdateNotice(ego, emit, { CI: "true" });
  await flushMicrotasks();
  assert.equal(lines.length, 0);
});

test("emitUpdateNotice swallows a throwing emit rather than rejecting", async () => {
  const ego = {
    getBrowserVersion: async () => ({
      currentVersion: "0.4.3.0",
      updateAvailable: true,
      latestVersion: "0.4.4.0",
    }),
  };
  // A throwing emit must not surface as an unhandled rejection (which would fail the run).
  emitUpdateNotice(
    ego,
    () => {
      throw new Error("write failed");
    },
    {},
  );
  await flushMicrotasks();
  assert.ok(true);
});
