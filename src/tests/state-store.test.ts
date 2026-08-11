import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserStateStore } from "../main/state-store.js";
import type { BrowserState, SpaceRecord } from "../main/types.js";

test("temporary Spaces never enter restart state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-state-store-"));
  const path = join(root, "browser-state.json");
  const store = new BrowserStateStore(path);
  try {
    const state: BrowserState = {
      version: 1,
      nextSpaceId: 4,
      spaces: [
        space(1, "persistent", "default"),
        space(
          2,
          "temporary",
          "temporary",
          "59f86d8e-69cc-4b93-b030-6c83643d7dd1",
        ),
        space(
          3,
          "temporary",
          "temporary",
          "3a0d2499-31a4-41f6-b6f1-b2f5e55f5743",
        ),
      ],
    };

    await store.save(state);
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    assert.equal(onDisk.nextSpaceId, 4);
    assert.deepEqual(onDisk.spaces.map((entry: SpaceRecord) => entry.id), [1]);

    const restored = await store.load();
    assert.deepEqual(restored.spaces.map((entry) => entry.id), [1]);
    assert.equal(restored.spaces[0].profileMode, "persistent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cold start drops a stale temporary record written by an older build", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-state-store-stale-"));
  const path = join(root, "browser-state.json");
  const store = new BrowserStateStore(path);
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        nextSpaceId: 3,
        spaces: [
          space(1, "persistent", "default"),
          space(
            2,
            "temporary",
            "temporary",
            "59f86d8e-69cc-4b93-b030-6c83643d7dd1",
          ),
        ],
      })}\n`,
    );
    const restored = await store.load();
    assert.deepEqual(restored.spaces.map((entry) => entry.id), [1]);
    assert.equal(restored.nextSpaceId, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function space(
  id: number,
  profileMode: SpaceRecord["profileMode"],
  profileId: string,
  sessionScopeId?: string,
): SpaceRecord {
  const now = 1_700_000_000_000 + id;
  return {
    id,
    taskId: `space-${id}`,
    name: `Space ${id}`,
    createdBy: id === 1 ? "user" : "agent",
    ownership: id === 1 ? "user" : "agent",
    lifecycle: "active",
    profileId,
    profileMode,
    sessionScopeId,
    tabs: [
      {
        targetId: `tab-${id}`,
        url: "https://example.com/",
        title: "Example",
        createdAt: now,
      },
    ],
    activeTabId: `tab-${id}`,
    createdAt: now,
    updatedAt: now,
  };
}
