import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  redactEventData,
  SpaceEventJournal,
} from "../main/space-event-journal.js";

test("SpaceEventJournal persists bounded monotonic events across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-event-journal-"));
  try {
    let now = 1_000;
    const first = new SpaceEventJournal({
      directory: root,
      maxEventsPerSpace: 3,
      maxAgeMs: 10_000,
      now: () => now,
    });
    await first.initialize();
    for (let index = 0; index < 4; index += 1) {
      first.append({
        spaceId: 7,
        category: "action",
        type: `step.${index}`,
      });
      now += 10;
    }
    await first.flush();
    const bounded = first.list(7, { limit: 10 });
    assert.deepEqual(
      bounded.events.map((event) => event.type),
      ["step.1", "step.2", "step.3"],
    );
    assert.equal(bounded.cursorExpired, false);

    const restored = new SpaceEventJournal({
      directory: root,
      maxEventsPerSpace: 3,
      maxAgeMs: 10_000,
      now: () => now,
    });
    await restored.initialize();
    const appended = restored.append({
      spaceId: 7,
      category: "navigation",
      type: "Page.frameNavigated",
    });
    assert.equal(appended.sequence, 5);
    const after = restored.list(7, { after: 2, limit: 2 });
    assert.deepEqual(after.events.map((event) => event.sequence), [3, 4]);
    assert.equal(after.nextSequence, 4);
    await restored.flush();

    now += 20_000;
    const afterExpiry = new SpaceEventJournal({
      directory: root,
      maxEventsPerSpace: 3,
      maxAgeMs: 10,
      now: () => now,
    });
    await afterExpiry.initialize();
    const afterExpiredHistory = afterExpiry.append({
      spaceId: 7,
      category: "lifecycle",
      type: "after-expiry",
    });
    assert.equal(afterExpiredHistory.sequence, 6);
    await afterExpiry.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SpaceEventJournal redacts credentials before memory and disk storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-event-redaction-"));
  try {
    const journal = new SpaceEventJournal({ directory: root });
    await journal.initialize();
    journal.append({
      spaceId: 9,
      category: "network",
      type: "request",
      data: {
        password: "hunter2",
        Authorization: "Bearer abc.def.ghi",
        url: "https://example.com/?token=secret-value&view=ok",
        nested: { cookie: "session=private", label: "safe" },
      },
    });
    await journal.flush();
    const event = journal.list(9).events[0];
    assert.equal(event.data?.password, "[redacted]");
    assert.equal(event.data?.Authorization, "[redacted]");
    assert.doesNotMatch(String(event.data?.url), /secret-value/);
    assert.equal((event.data?.nested as any).cookie, "[redacted]");
    assert.equal((event.data?.nested as any).label, "safe");
    const persisted = await readFile(join(root, "space-9.json"), "utf8");
    assert.doesNotMatch(persisted, /hunter2|abc\.def|secret-value|session=private/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redactEventData limits depth, array size, and sensitive free text", () => {
  const redacted = redactEventData({
    message: "password=hello token:world",
    items: Array.from({ length: 150 }, (_, index) => index),
  }) as any;
  assert.doesNotMatch(redacted.message, /hello|world/);
  assert.equal(redacted.items.length, 100);
});
