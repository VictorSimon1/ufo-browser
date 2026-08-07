import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImportedChromeCookie } from "../main/chrome-import/cookies.js";
import type { CookieWriteTarget } from "../main/chrome-import/cookie-writer.js";
import { BrowserProfileRegistry } from "../main/profile-registry.js";
import { ProfileSyncCheckpointStore } from "../main/profile-sync/checkpoint-store.js";
import { diffProfileCookies } from "../main/profile-sync/cookie-diff.js";
import { ProfileSyncService } from "../main/profile-sync/service.js";
import type {
  ProfileCookieSourceProvider,
  ProfileCookieSourceSnapshot,
} from "../main/profile-sync/source-providers.js";

test("Profile sync gates unchanged revisions and applies only source deltas", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.service.syncProfile("chrome-clone", "test");
    assert.equal(first.result, "baselined");
    assert.equal(fixture.target.cookiesState[0].value, "before");

    const unchanged = await fixture.service.syncProfile("chrome-clone", "test");
    assert.equal(unchanged.result, "unchanged");
    assert.equal(fixture.provider.cookieReads, 1);

    fixture.provider.revision = "b".repeat(64);
    fixture.provider.cookies = [cookie("after")];
    const updated = await fixture.service.syncProfile("chrome-clone", "test");
    assert.equal(updated.result, "updated");
    assert.equal(updated.changed, 1);
    assert.equal(fixture.target.cookiesState[0].value, "after");
  } finally {
    await fixture.close();
  }
});

test("Profile sync preserves a UFO logout when the source later changes", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.syncProfile("chrome-clone", "test");
    fixture.target.cookiesState = [];

    const unchanged = await fixture.service.syncProfile("chrome-clone", "test");
    assert.equal(unchanged.result, "unchanged");
    assert.equal(fixture.target.cookiesState.length, 0);

    fixture.provider.revision = "c".repeat(64);
    fixture.provider.cookies = [cookie("source-new")];
    const conflict = await fixture.service.syncProfile("chrome-clone", "test");
    assert.equal(conflict.result, "conflict");
    assert.equal(conflict.conflicts, 1);
    assert.equal(fixture.target.cookiesState.length, 0);
  } finally {
    await fixture.close();
  }
});

test("enabling sync is explicit and a first scan only establishes a baseline", async () => {
  const fixture = await createFixture(false, "ufo-current");
  try {
    assert.equal(
      fixture.registry.getOrThrow("chrome-clone").source?.loginSyncEnabled,
      false,
    );
    const status = await fixture.service.setEnabled("chrome-clone", true);
    assert.equal(status.result, "baselined");
    assert.equal(fixture.target.cookiesState[0].value, "ufo-current");
    assert.equal(
      fixture.registry.getOrThrow("chrome-clone").source?.loginSyncEnabled,
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("seeding Cookie checkpoints waits for storage preparation and preserves storage revisions", async () => {
  const fixture = await createFixture();
  try {
    const storage = {
      "Local Storage": {
        sourceRevision: "d".repeat(64),
        targetRevision: "e".repeat(64),
        updatedAt: 100,
      },
    };
    await fixture.checkpoints.save({
      version: 1,
      profileId: "chrome-clone",
      cookies: {},
      storage,
      updatedAt: 100,
    });

    await fixture.service.seedProfile("chrome-clone", [cookie("seed")]);
    const checkpoint = await fixture.checkpoints.load("chrome-clone");
    assert.deepEqual(checkpoint?.storage, storage);
    assert.equal(fixture.prepareCalls(), 1);
  } finally {
    await fixture.close();
  }
});

async function createFixture(enabled = true, targetValue = "before") {
  const root = await mkdtemp(join(tmpdir(), "ufo-profile-sync-service-"));
  const registry = new BrowserProfileRegistry(join(root, "profiles.json"));
  await registry.initialize();
  const now = Date.now();
  await registry.add({
    id: "chrome-clone",
    partitionId: "x-browser-profile-chrome-clone",
    name: "Chrome Clone",
    kind: "imported",
    source: {
      type: "chrome",
      browser: "chrome",
      profileDirName: "Default",
      displayName: "Default",
      importedAt: now,
      lastImportStatus: "success",
      loginSyncEnabled: enabled,
    },
    createdAt: now,
    updatedAt: now,
  });
  const provider = new MockSourceProvider([cookie("before")]);
  const target = new MemoryCookieTarget([cookie(targetValue)]);
  const checkpoints = new ProfileSyncCheckpointStore(join(root, "checkpoints"));
  let prepareCalls = 0;
  const service = new ProfileSyncService({
    profiles: registry,
    checkpoints,
    sourceProviders: [provider],
    createTarget: async () => target,
    prepareTarget: async () => {
      prepareCalls++;
    },
    diffCookies: async (source, current, checkpoint, at) =>
      diffProfileCookies(source, current, checkpoint, at),
    startupDelayMs: 60_000,
    scanIntervalMs: 60_000,
  });
  return {
    root,
    registry,
    provider,
    target,
    checkpoints,
    prepareCalls: () => prepareCalls,
    service,
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

class MockSourceProvider implements ProfileCookieSourceProvider {
  revision = "a".repeat(64);
  cookieReads = 0;

  constructor(public cookies: ImportedChromeCookie[]) {}

  supports(source: any) {
    return source?.type === "chrome";
  }

  async snapshot(
    _profile: any,
    previousRevision?: string,
  ): Promise<ProfileCookieSourceSnapshot> {
    if (previousRevision === this.revision) {
      return { unchanged: true, revision: this.revision };
    }
    this.cookieReads++;
    return {
      unchanged: false,
      revision: this.revision,
      cookies: structuredClone(this.cookies),
    };
  }
}

class MemoryCookieTarget implements CookieWriteTarget {
  disposed = false;

  constructor(public cookiesState: ImportedChromeCookie[]) {}

  get cookies() {
    const state = this;
    return {
      async get() {
        return state.cookiesState.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: cookie.hostOnly,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          expirationDate: cookie.expirationDate,
          session: cookie.wasSessionCookie,
        })) as Electron.Cookie[];
      },
      async set(details: Electron.CookiesSetDetails) {
        const url = new URL(details.url);
        const domain = details.domain || url.hostname;
        const next = cookie(String(details.value || ""));
        next.name = String(details.name || "");
        next.domain = domain;
        next.hostOnly = !details.domain;
        next.path = details.path || "/";
        next.secure = Boolean(details.secure);
        next.httpOnly = Boolean(details.httpOnly);
        next.sameSite = (details.sameSite || "unspecified") as any;
        next.expirationDate = Number(details.expirationDate) || 0;
        const index = state.cookiesState.findIndex(
          (value) =>
            value.name === next.name &&
            value.domain.replace(/^\./, "") === next.domain.replace(/^\./, "") &&
            value.path === next.path,
        );
        if (index >= 0) state.cookiesState[index] = next;
        else state.cookiesState.push(next);
      },
      async remove(urlValue: string, name: string) {
        const host = new URL(urlValue).hostname;
        state.cookiesState = state.cookiesState.filter(
          (value) =>
            !(
              value.name === name &&
              value.domain.replace(/^\./, "") === host
            ),
        );
      },
    };
  }

  get cdp() {
    return {
      send: async (method: string) => {
        if (method === "Network.getAllCookies") return { cookies: [] };
        if (method === "Network.setCookie") return { success: true };
        if (method === "Network.deleteCookies") return {};
        return {};
      },
    };
  }

  async flush() {}

  async dispose() {
    this.disposed = true;
  }
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
