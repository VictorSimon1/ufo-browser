import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
