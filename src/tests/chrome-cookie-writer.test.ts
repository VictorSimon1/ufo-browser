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

test("Cookie writer verifies 10,000 Cookies with bounded concurrency and indexed lookups", async () => {
  const target = new LargeCookieTarget();
  const cookies = Array.from({ length: 10_000 }, (_, index) =>
    cookie({
      name: `cookie-${index}`,
      value: `value-${index}`,
    }),
  );
  const result = await writeAndVerifyCookies(target, cookies, 8);
  assert.deepEqual(result, {
    written: 10_000,
    partitioned: 0,
    verified: 10_000,
  });
  assert.ok(target.maxInFlight <= 8, `observed ${target.maxInFlight} writes`);
  assert.ok(
    target.nameReads <= 30_000,
    `verification used ${target.nameReads} Cookie name reads`,
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
      if (method === "Network.getAllCookies") {
        return {
          cookies: this.partitioned.map((cookie) => ({
            ...cookie,
            partitionKey: cookie.partitionKey
              ? {
                  ...cookie.partitionKey,
                  topLevelSite: `${cookie.partitionKey.topLevelSite}/`,
                }
              : undefined,
          })),
        };
      }
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };
  flush() {
    this.flushed++;
  }
  dispose() {}
}

class LargeCookieTarget implements CookieWriteTarget {
  private readonly regular: any[] = [];
  inFlight = 0;
  maxInFlight = 0;
  nameReads = 0;
  cookies = {
    set: async (details: any) => {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      try {
        await Promise.resolve();
        this.regular.push({
          ...details,
          domain: details.domain ?? new URL(details.url).hostname,
          hostOnly: !details.domain,
          sameSite: details.sameSite ?? "unspecified",
        });
      } finally {
        this.inFlight--;
      }
    },
    get: async () =>
      [...this.regular].reverse().map((cookie: any) => {
        const actual = { ...cookie };
        Object.defineProperty(actual, "name", {
          enumerable: true,
          get: () => {
            this.nameReads++;
            return cookie.name;
          },
        });
        return actual;
      }),
  };
  cdp = {
    send: async () => {
      throw new Error("unexpected CDP method");
    },
  };
  flush() {}
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
