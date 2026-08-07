import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImportedChromeCookie } from "../main/chrome-import/cookies.js";
import type { CookieWriteTarget } from "../main/chrome-import/cookie-writer.js";
import {
  discoverChromeProfileAvatar,
  ProfileAvatarStore,
} from "../main/profile-avatar-store.js";
import { ProfileCloneService } from "../main/profile-clone/service.js";
import {
  BrowserProfileRegistry,
  DEFAULT_PROFILE_PARTITION_ID,
} from "../main/profile-registry.js";

test("Profile avatars import, clone, and expose only validated image data", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-profile-avatar-"));
  try {
    const source = join(root, "Google Profile Picture.png");
    await writeFile(source, pngFixture());
    const store = new ProfileAvatarStore(join(root, "avatars"));
    assert.equal(await store.importFromPath("default", source), true);
    assert.match(String(await store.dataUrl("default")), /^data:image\/png;base64,/);
    assert.equal(await store.clone("default", "ufo-copy"), true);
    assert.equal(await store.dataUrl("ufo-copy"), await store.dataUrl("default"));
    assert.equal(
      await discoverChromeProfileAvatar(root, {}),
      source,
    );
    await store.remove("ufo-copy");
    assert.equal(await store.dataUrl("ufo-copy"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UFO Profile clone copies login storage, Cookie state, source binding, and avatar", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-profile-clone-"));
  const partitionsRoot = join(root, "Partitions");
  const registry = new BrowserProfileRegistry(join(root, "profiles.json"));
  try {
    await registry.initialize();
    const sourcePartition = join(partitionsRoot, DEFAULT_PROFILE_PARTITION_ID);
    await mkdir(join(sourcePartition, "Local Storage", "leveldb"), {
      recursive: true,
    });
    await writeFile(
      join(sourcePartition, "Local Storage", "leveldb", "000001.ldb"),
      "login-storage",
    );
    const avatars = new ProfileAvatarStore(join(root, "avatars"));
    const sourceAvatar = join(root, "source.png");
    await writeFile(sourceAvatar, pngFixture());
    await avatars.importFromPath("default", sourceAvatar);
    const cookieState = new Map<string, ImportedChromeCookie[]>([
      ["default", [cookie("signed-in")]],
    ]);
    let seededProfileId = "";
    const service = new ProfileCloneService({
      profiles: registry,
      partitionsRoot,
      avatars,
      sync: {
        async seedProfile(profileId: string) {
          seededProfileId = profileId;
        },
      } as any,
      createTarget: async (profile) =>
        new MemoryCookieTarget(cookieState, profile.id),
      now: () => 1_000,
    });
    const cloned = await service.cloneUfoProfile({
      sourceProfileId: "default",
      name: "工作 Profile",
      makeDefault: true,
      loginSyncEnabled: true,
    });
    assert.equal(cloned.source?.type, "ufo");
    assert.equal(
      cloned.source?.type === "ufo" ? cloned.source.profileId : "",
      "default",
    );
    assert.equal(cloned.source?.loginSyncEnabled, true);
    assert.equal(registry.getDefault().id, cloned.id);
    assert.equal(seededProfileId, cloned.id);
    assert.equal(cookieState.get(cloned.id)?.[0].value, "signed-in");
    assert.equal(
      await readFile(
        join(
          partitionsRoot,
          cloned.partitionId,
          "Local Storage",
          "leveldb",
          "000001.ldb",
        ),
        "utf8",
      ),
      "login-storage",
    );
    assert.match(String(await avatars.dataUrl(cloned.id)), /^data:image\/png;base64,/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class MemoryCookieTarget implements CookieWriteTarget {
  constructor(
    private readonly state: Map<string, ImportedChromeCookie[]>,
    private readonly profileId: string,
  ) {
    if (!state.has(profileId)) state.set(profileId, []);
  }

  get cookies() {
    return {
      get: async () =>
        (this.state.get(this.profileId) ?? []).map((value) => ({
          name: value.name,
          value: value.value,
          domain: value.domain,
          hostOnly: value.hostOnly,
          path: value.path,
          secure: value.secure,
          httpOnly: value.httpOnly,
          sameSite: value.sameSite,
          expirationDate: value.expirationDate,
          session: value.wasSessionCookie,
        })) as Electron.Cookie[],
      set: async (details: Electron.CookiesSetDetails) => {
        const next = cookie(String(details.value || ""));
        next.name = String(details.name || "");
        next.domain = details.domain || new URL(details.url).hostname;
        next.hostOnly = !details.domain;
        next.path = details.path || "/";
        next.secure = Boolean(details.secure);
        next.httpOnly = Boolean(details.httpOnly);
        next.sameSite = (details.sameSite || "unspecified") as any;
        next.expirationDate = Number(details.expirationDate) || 0;
        this.state.set(this.profileId, [next]);
      },
      remove: async () => {
        this.state.set(this.profileId, []);
      },
    };
  }

  get cdp() {
    return {
      send: async (method: string) =>
        method === "Network.getAllCookies" ? { cookies: [] } : { success: true },
    };
  }

  async flush() {}
  async dispose() {}
}

function cookie(value: string): ImportedChromeCookie {
  return {
    domain: "example.com",
    hostOnly: true,
    name: "session",
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

function pngFixture() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("fixture-avatar"),
  ]);
}
