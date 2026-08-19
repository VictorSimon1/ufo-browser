import test from "node:test";
import assert from "node:assert/strict";
import { ProfileRequestService } from "../main/profile-request.js";
import { SpaceEventJournal } from "../main/space-event-journal.js";

test("Profile Request uses the selected Chromium Session and records only safe metadata", async () => {
  const journal = new SpaceEventJournal();
  await journal.initialize();
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const chromiumSession = {
    fetch: async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ authenticated: true }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "set-cookie": "profile-session=secret-cookie; Path=/",
          "x-fixture": "profile-request",
        },
      });
    },
  };
  const manager = fakeManager(chromiumSession);
  const service = new ProfileRequestService(manager as any, journal);
  const secret = "Bearer profile-request-secret-token";
  const result = await service.request(7, "connection-1", "/api/token/hidden?token=hidden", {
    method: "POST",
    headers: {
      Authorization: secret,
      "content-type": "application/json",
    },
    body: {
      encoding: "utf8",
      data: JSON.stringify({ password: "hidden-password" }),
    },
  });

  assert.equal(capturedUrl, "https://example.com/api/token/hidden?token=hidden");
  assert.equal(capturedInit?.credentials, "include");
  assert.equal((capturedInit?.headers as any).Authorization, secret);
  assert.equal(Buffer.from(capturedInit?.body as any).toString(), '{"password":"hidden-password"}');
  assert.equal(result.status, 201);
  assert.equal(result.ok, true);
  assert.equal(result.headers.some(([name]) => name === "set-cookie"), false);
  assert.equal(
    Buffer.from(result.bodyBase64, "base64").toString(),
    '{"authenticated":true}',
  );

  const persistedShape = JSON.stringify(journal.list(7, { limit: 20 }));
  assert.equal(persistedShape.includes(secret), false);
  assert.equal(persistedShape.includes("hidden-password"), false);
  assert.equal(persistedShape.includes("hidden"), false);
  assert.match(persistedShape, /network\.profile-request\.started/);
  assert.match(persistedShape, /network\.profile-request\.finished/);
  assert.match(persistedShape, /\/api\/token\/\[redacted\]/);
});

test("Profile Request rejects Chromium identity overrides before dispatch", async () => {
  let calls = 0;
  const manager = fakeManager({
    fetch: async () => {
      calls += 1;
      return new Response("unexpected");
    },
  });
  const service = new ProfileRequestService(manager as any);
  for (const header of [
    "Cookie",
    "Host",
    "Content-Length",
    "Connection",
    "Transfer-Encoding",
    "Upgrade",
    "Proxy-Authorization",
    "Sec-CH-UA",
    "User-Agent",
    "Accept-Language",
  ]) {
    await assert.rejects(
      () => service.request(7, "connection-1", "https://example.com/", {
        headers: { [header]: "forbidden-secret" },
      }),
      /EGO_PROFILE_REQUEST_FORBIDDEN_HEADER/,
    );
  }
  assert.equal(calls, 0);
});

test("Profile Request stops reading at the configured response limit", async () => {
  const manager = fakeManager({
    fetch: async () => new Response("1234567890"),
  });
  const service = new ProfileRequestService(manager as any);
  await assert.rejects(
    () => service.request(7, "connection-1", "https://example.com/large", {
      maxResponseBytes: 4,
    }),
    /EGO_PROFILE_REQUEST_RESPONSE_TOO_LARGE/,
  );
});

test("Profile Request bounds response headers before socket serialization", async () => {
  const manager = fakeManager({
    fetch: async () =>
      new Response("small", {
        headers: { "x-oversized": "x".repeat(70 * 1024) },
      }),
  });
  const service = new ProfileRequestService(manager as any);
  await assert.rejects(
    () => service.request(7, "connection-1", "https://example.com/headers"),
    /EGO_PROFILE_REQUEST_RESPONSE_HEADERS_TOO_LARGE/,
  );
});

function fakeManager(chromiumSession: { fetch: (...args: any[]) => any }) {
  const space: any = {
    id: 7,
    name: "profile request",
    taskId: "profile request",
    lifecycle: "active",
    ownership: "agent",
    profileId: "temporary",
    profileMode: "temporary",
    activeTabId: "page-7",
    tabs: [
      {
        targetId: "page-7",
        title: "Fixture",
        url: "https://example.com/base/page.html",
      },
    ],
  };
  return {
    getSpaceOrThrow: (spaceId: number) => {
      if (spaceId !== space.id) throw new Error("space not found");
      return space;
    },
    profileSessionForSpace: async () => chromiumSession,
  };
}
