import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCefTaskSpaceManager } from "../main/native-cef-task-space-manager.js";

test("Native Profile Cookie transactions reuse the one shared UFO CEF Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-native-profile-host-"));
  const created: any[] = [];
  const controls: Array<{ spaceId: number; command: string }> = [];
  let internalSpaceId = 0;
  let internalSpaceClosed = false;
  const browserConnection = {
    send: async (method: string) => {
      if (method === "Target.getTargets") {
        return {
          targetInfos: [{
            targetId: "profile-operation-target",
            type: "page",
            title: "",
            url: "https://example.com/",
            ufoSpaceId: internalSpaceId,
          }],
        };
      }
      throw new Error(`unexpected browser method: ${method}`);
    },
    close: async () => undefined,
  };
  const pageConnection = {
    send: async (method: string) => {
      if (method === "Network.enable") return {};
      if (method === "Network.getAllCookies") return { cookies: [] };
      if (method === "Network.setCookie") return { success: true };
      if (method === "Network.deleteCookies") return {};
      throw new Error(`unexpected page method: ${method}`);
    },
    close: async () => undefined,
  };
  const sharedHost = {
    isRunning: () => true,
    usesPrivateBridge: () => true,
    version: async () => ({ Browser: "UFO-Browser/test" }),
    createSharedSpace: async (space: any) => {
      created.push(space);
      internalSpaceId = space.id;
      return { ok: true, spaceId: space.id, browserRoute: `space:${space.id}` };
    },
    connectBrowser: async () => browserConnection,
    connect: async () => pageConnection,
    listSharedSpaceBrowsers: async () => [{
      browserId: 1,
      route: "browser:1",
      primary: true,
      url: "https://example.com/",
    }],
    controlSharedSpace: async (spaceId: number, command: string) => {
      controls.push({ spaceId, command });
      if (command === "close-space") internalSpaceClosed = true;
      if (command === "status-space" && internalSpaceClosed) {
        throw new Error("error space-not-found");
      }
      return "ok";
    },
  } as any;
  const manager = new NativeCefTaskSpaceManager({
    store: {} as any,
    profiles: {} as any,
    partitionsRoot: root,
    sharedHost,
  });

  try {
    const target = await manager.createProfileCookieWriteTarget(
      "import-in-progress",
      "profile-import-target",
    );
    assert.equal(created.length, 1);
    assert.equal(created[0].visible, false);
    assert.equal(created[0].chromeShell, false);
    assert.ok(created[0].id > 1_000_000_000);
    assert.equal(created[0].cachePath, join(root, "profile-import-target"));
    assert.deepEqual(await target.cookies.get({} as any), []);
    await target.dispose();
    assert.deepEqual(controls, [
      { spaceId: created[0].id, command: "close-space" },
      { spaceId: created[0].id, command: "status-space" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Native Profile Cookie seeding is serialized and marked after the first run", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-native-cookie-seed-"));
  let calls = 0;
  const manager = new NativeCefTaskSpaceManager({
    store: {} as any,
    profiles: {} as any,
    partitionsRoot: root,
    seedCookies: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return true;
    },
  });
  (manager as any).createNativeCookieTarget = async () => ({
    dispose: async () => undefined,
  });
  const space = { tabs: [{ url: "https://example.com/" }] } as any;
  const runtime = {} as any;
  try {
    const concurrent = await Promise.all([
      (manager as any).seedCookiesOnce("profile-a", runtime, space, root),
      (manager as any).seedCookiesOnce("profile-a", runtime, space, root),
    ]);
    const alreadySeeded = await (manager as any).seedCookiesOnce("profile-a", runtime, space, root);
    assert.equal(calls, 1);
    assert.deepEqual(concurrent, [true, true]);
    assert.equal(alreadySeeded, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Native Profile Cookie seeding retries legacy markers that did not import Cookies", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-native-cookie-seed-legacy-"));
  let calls = 0;
  const manager = new NativeCefTaskSpaceManager({
    store: {} as any,
    profiles: {} as any,
    partitionsRoot: root,
    seedCookies: async () => { calls += 1; return true; },
  });
  (manager as any).createNativeCookieTarget = async () => ({
    dispose: async () => undefined,
  });
  const markerPath = join(root, ".ufo-cookie-seed.json");
  const space = { tabs: [{ url: "https://example.com/" }] } as any;
  try {
    await writeFile(markerPath, JSON.stringify({
      version: 1,
      profileId: "profile-a",
      reason: "already-seeded",
      seededAt: 1,
    }));
    await (manager as any).seedCookiesOnce("profile-a", {} as any, space, root);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).reason, "imported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Native Profile Cookie seeding trusts only a matching imported marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-native-cookie-seed-valid-"));
  let calls = 0;
  const manager = new NativeCefTaskSpaceManager({
    store: {} as any,
    profiles: {} as any,
    partitionsRoot: root,
    seedCookies: async () => { calls += 1; return true; },
  });
  (manager as any).createNativeCookieTarget = async () => ({
    dispose: async () => undefined,
  });
  const markerPath = join(root, ".ufo-cookie-seed.json");
  const space = { tabs: [{ url: "https://example.com/" }] } as any;
  try {
    await writeFile(markerPath, JSON.stringify({
      version: 1,
      profileId: "profile-a",
      reason: "imported",
      seededAt: 1,
    }));
    await (manager as any).seedCookiesOnce("profile-a", {} as any, space, root);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Native Profile Cookie seeding does not reload when the source has no Cookies", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-native-cookie-seed-empty-"));
  let calls = 0;
  const manager = new NativeCefTaskSpaceManager({
    store: {} as any,
    profiles: {} as any,
    partitionsRoot: root,
    seedCookies: async () => { calls += 1; return false; },
  });
  (manager as any).createNativeCookieTarget = async () => ({
    dispose: async () => undefined,
  });
  const space = { tabs: [{ url: "https://example.com/" }] } as any;
  try {
    const first = await (manager as any).seedCookiesOnce("profile-a", {} as any, space, root);
    const second = await (manager as any).seedCookiesOnce("profile-a", {} as any, space, root);
    assert.equal(first, false);
    assert.equal(second, false);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Native Agent task text and pointer are routed to the outer AppKit overlay", async () => {
  const routed: any[] = [];
  const host = {
    isRunning: () => true,
    updateSharedSpaceAgentOverlay: async (...args: any[]) => { routed.push(["state", ...args]); },
    showSharedSpaceAgentPointer: async (...args: any[]) => { routed.push(["pointer", ...args]); },
  } as any;
  const manager = new NativeCefTaskSpaceManager({
    store: { save: async () => undefined } as any,
    profiles: { getDefault: () => ({ id: "profile-a" }) } as any,
    partitionsRoot: "/tmp/ufo-native-agent-overlay-test",
    sharedHost: host,
  });
  const space = await manager.createSpace("Agent checkout", "agent");
  (manager as any).runtimes.set(`space-${space.id}`, { isRunning: () => true });

  await manager.setAgentTaskState(space.id, {
    title: "Checkout",
    detail: "正在填写地址",
  });
  manager.showAgentPointer(space.id, 320, 240);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(routed, [
    ["state", space.id, "Checkout", "正在填写地址"],
    ["pointer", space.id, 320, 240],
  ]);
});
