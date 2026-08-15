import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCefOverview } from "../main/native-cef-overview.js";

test("hiding Native Overview cancels preview wakeups already waiting in its queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-native-overview-queue-"));
  const captures: number[] = [];
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const manager = {
    capturePreview: async (spaceId: number) => {
      captures.push(spaceId);
      if (spaceId === 1) {
        markFirstStarted?.();
        await firstBlocked;
      }
      return {
        available: true,
        dataUrl: "data:image/jpeg;base64,dGVzdA==",
        width: 1,
        height: 1,
        capturedAt: Date.now(),
      };
    },
  } as any;
  const overview = new NativeCefOverview({
    manager,
    userDataDir: root,
    devtoolsPort: 0,
    startRuntime: false,
  });

  try {
    const info = await overview.start();
    const first = fetch(`${info!.url}api/spaces/1/preview`).then((response) => response.json());
    await firstStarted;
    const second = fetch(`${info!.url}api/spaces/2/preview`).then((response) => response.json());
    const secondFinishedEarly = await Promise.race([
      second.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 40)),
    ]);
    assert.equal(secondFinishedEarly, false, "second preview should already be queued behind the first");

    await overview.hideWindow();
    releaseFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.available, true);
    assert.deepEqual(secondResult, { available: false });
    assert.deepEqual(captures, [1]);
  } finally {
    releaseFirst?.();
    await overview.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("creating a Native Space immediately presents its loaded Google window", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-native-overview-create-"));
  const calls: any[] = [];
  const manager = {
    createSpace: async (name: string, ownership: string, profileId?: string) => {
      calls.push(["create", name, ownership, profileId]);
      return { id: 42, name, profileId, tabs: [{ url: "https://www.google.com/" }] };
    },
  } as any;
  const overview = new NativeCefOverview({
    manager,
    userDataDir: root,
    devtoolsPort: 0,
    startRuntime: false,
  });
  overview.setPresentationController({
    openSpace: async (spaceId: number) => { calls.push(["open", spaceId]); },
    showOverview: async () => undefined,
    closeSpace: async () => true,
  });

  try {
    const info = await overview.start();
    const response = await fetch(`${info!.url}api/spaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Space", profileId: "chrome-main" }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(calls, [
      ["create", "New Space", "user", "chrome-main"],
      ["open", 42],
    ]);
    const result = await response.json() as any;
    assert.equal(result.space.tabs[0].url, "https://www.google.com/");
  } finally {
    await overview.stop();
    await rm(root, { recursive: true, force: true });
  }
});
