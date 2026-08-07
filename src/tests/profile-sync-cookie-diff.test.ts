import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImportedChromeCookie } from "../main/chrome-import/cookies.js";
import {
  diffProfileCookies,
  type CookieSyncCheckpoint,
} from "../main/profile-sync/cookie-diff.js";
import {
  ProfileSyncCheckpointStore,
  type ProfileSyncCheckpoint,
} from "../main/profile-sync/checkpoint-store.js";
import { createProfileCookieDiffWorker } from "../main/profile-sync/cookie-diff-worker-reader.js";

test("Cookie sync baselines without overwriting either side", () => {
  const source = cookie("source-value");
  const target = cookie("ufo-value");
  const diff = diffProfileCookies([source], [target], undefined, 100);
  assert.equal(diff.set.length, 0);
  assert.equal(diff.remove.length, 0);
  assert.equal(diff.stats.baselined, 1);
});

test("source changes apply only while UFO still matches the checkpoint", () => {
  const baseline = diffProfileCookies(
    [cookie("before")],
    [cookie("before")],
    undefined,
    100,
  ).checkpoint;
  const changed = diffProfileCookies(
    [cookie("after")],
    [cookie("before")],
    baseline,
    200,
  );
  assert.deepEqual(changed.set.map((value) => value.value), ["after"]);
  assert.equal(changed.stats.conflicts, 0);
});

test("a UFO logout is never resurrected while the source is unchanged", () => {
  const baseline = diffProfileCookies(
    [cookie("signed-in")],
    [cookie("signed-in")],
    undefined,
    100,
  ).checkpoint;
  const unchangedSource = diffProfileCookies(
    [cookie("signed-in")],
    [],
    baseline,
    200,
  );
  assert.equal(unchangedSource.set.length, 0);
  assert.equal(unchangedSource.remove.length, 0);

  const laterSourceChange = diffProfileCookies(
    [cookie("source-changed")],
    [],
    unchangedSource.checkpoint,
    300,
  );
  assert.equal(laterSourceChange.set.length, 0);
  assert.equal(laterSourceChange.stats.conflicts, 1);
});

test("source deletion propagates only when UFO did not diverge", () => {
  const baseline = diffProfileCookies(
    [cookie("value")],
    [cookie("value")],
    undefined,
    100,
  ).checkpoint;
  const removed = diffProfileCookies([], [cookie("value")], baseline, 200);
  assert.equal(removed.remove.length, 1);
  assert.equal(removed.stats.removed, 1);

  const divergent = diffProfileCookies(
    [],
    [cookie("ufo-new")],
    baseline,
    200,
  );
  assert.equal(divergent.remove.length, 0);
  assert.equal(divergent.stats.conflicts, 1);
});

test("both-side changes preserve UFO and advance the conflict checkpoint", () => {
  const baseline = diffProfileCookies(
    [cookie("before")],
    [cookie("before")],
    undefined,
    100,
  ).checkpoint;
  const conflict = diffProfileCookies(
    [cookie("source-new")],
    [cookie("ufo-new")],
    baseline,
    200,
  );
  assert.equal(conflict.set.length, 0);
  assert.equal(conflict.stats.conflicts, 1);
  const settled = diffProfileCookies(
    [cookie("source-new")],
    [cookie("ufo-new")],
    conflict.checkpoint,
    300,
  );
  assert.equal(settled.stats.sourceChanged, 0);
  assert.equal(settled.stats.conflicts, 0);
});

test("checkpoint files contain hashes but no Cookie identity or value", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-profile-sync-"));
  try {
    const cookies: CookieSyncCheckpoint = diffProfileCookies(
      [cookie("top-secret")],
      [cookie("top-secret")],
      undefined,
      100,
    ).checkpoint;
    const checkpoint: ProfileSyncCheckpoint = {
      version: 1,
      profileId: "chrome-safe",
      sourceRevision: "a".repeat(64),
      cookies,
      storage: {},
      updatedAt: 100,
    };
    const store = new ProfileSyncCheckpointStore(root);
    await store.save(checkpoint);
    assert.deepEqual(await store.load("chrome-safe"), checkpoint);
    const persisted = await readFile(join(root, "chrome-safe.json"), "utf8");
    assert.doesNotMatch(persisted, /top-secret|example\.com|session/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("10,000 Cookie diff stays off the main event loop", async () => {
  const source = Array.from({ length: 10_000 }, (_, index) =>
    cookie(`value-${index}`, `session-${index}`),
  );
  const target = source.map((value) => ({ ...value }));
  const checkpoint = diffProfileCookies(source, target, undefined, 100).checkpoint;
  source[9_999] = cookie("changed", "session-9999");
  const worker = createProfileCookieDiffWorker(
    new URL(
      "../main/profile-sync-cookie-diff-worker.js",
      import.meta.url,
    ).pathname,
  );
  const heartbeat = eventLoopHeartbeat(2);
  const diff = await worker(source, target, checkpoint, 200);
  const responsiveness = heartbeat.stop();
  assert.equal(diff.set.length, 1);
  assert.ok(responsiveness.ticks >= 2, JSON.stringify(responsiveness));
  assert.ok(responsiveness.maxStallMs < 50, JSON.stringify(responsiveness));
});

function cookie(value: string, name = "session"): ImportedChromeCookie {
  return {
    domain: ".example.com",
    hostOnly: false,
    name,
    value,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    expirationDate: 2_000_000_000,
    wasSessionCookie: false,
    priority: "Medium",
    sourceScheme: "Secure",
    sourcePort: 443,
    sourceType: 0,
    lastUpdateChromeTime: "0",
  };
}

function eventLoopHeartbeat(intervalMs: number) {
  let ticks = 0;
  let maxGapMs = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - previous);
    previous = now;
    ticks++;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return {
        ticks,
        maxGapMs,
        maxStallMs: Math.max(0, maxGapMs - intervalMs),
      };
    },
  };
}
