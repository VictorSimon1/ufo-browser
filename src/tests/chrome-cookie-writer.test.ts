import test from "node:test";
import assert from "node:assert/strict";
import {
  cookieUrl,
  writeAndVerifyCookies,
  type CookieWriteTarget,
} from "../main/chrome-import/cookie-writer.js";
import type { ImportedChromeCookie } from "../main/chrome-import/cookies.js";

test("Cookie writer uses Electron for regular Cookies and CDP for CHIPS", async () => {
  const target = new FakeCookieTarget();
  const regular = cookie({ name: "regular" });
  const partitioned = cookie({
    name: "partitioned",
    partitionKey: {
      topLevelSite: "https://top.example",
      hasCrossSiteAncestor: true,
    },
  });
  const result = await writeAndVerifyCookies(target, [regular, partitioned], 2);
  assert.deepEqual(result, { written: 2, partitioned: 1, verified: 2 });
  assert.equal(target.regular.length, 1);
  assert.equal(target.partitioned.length, 1);
  assert.equal(target.flushed, 1);
  assert.equal(target.partitioned[0].partitionKey.topLevelSite, "https://top.example");
});

test("Cookie verification failures expose counts but never values or domains", async () => {
  const target = new FakeCookieTarget();
  target.dropWrites = true;
  const secretCookie = cookie({
    domain: "secret.example",
    name: "authorization",
    value: "do-not-expose",
  });
  await assert.rejects(
    writeAndVerifyCookies(target, [secretCookie]),
    (error: Error) => {
      assert.match(error.message, /1 mismatches/);
      assert.doesNotMatch(error.message, /secret\.example|authorization|do-not-expose/);
      return true;
    },
  );
});

test("Cookie URLs normalize domain Cookies without weakening secure transport", () => {
  assert.equal(cookieUrl(cookie({ domain: ".example.com" })), "https://example.com/");
  assert.equal(cookieUrl(cookie({ domain: "::1" })), "https://[::1]/");
  assert.throws(
    () => cookieUrl(cookie({ domain: "../escape" })),
    /invalid Cookie domain/,
  );
});

class FakeCookieTarget implements CookieWriteTarget {
  regular: any[] = [];
  partitioned: any[] = [];
  flushed = 0;
  dropWrites = false;
  cookies = {
    set: async (details: any) => {
      if (!this.dropWrites) {
        this.regular.push({
          ...details,
          domain: details.domain ?? new URL(details.url).hostname,
          hostOnly: !details.domain,
          sameSite: details.sameSite ?? "unspecified",
        });
      }
    },
    get: async () => this.regular,
  };
  cdp = {
    send: async (method: string, params?: any) => {
      if (method === "Network.setCookie") {
        if (!this.dropWrites) {
          this.partitioned.push({
            ...params,
            domain: params.domain ?? new URL(params.url).hostname,
          });
        }
        return { success: true };
      }
      if (method === "Storage.getCookies") {
        return { cookies: this.partitioned };
      }
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };
  flush() {
    this.flushed++;
  }
  dispose() {}
}

function cookie(
  overrides: Partial<ImportedChromeCookie> = {},
): ImportedChromeCookie {
  return {
    domain: "example.com",
    hostOnly: true,
    name: "session",
    value: "value",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    expirationDate: 1_900_000_000,
    wasSessionCookie: false,
    priority: "Medium",
    sourceScheme: "Secure",
    sourcePort: 443,
    sourceType: 1,
    lastUpdateChromeTime: "0",
    ...overrides,
  };
}
