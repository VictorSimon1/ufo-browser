import test from "node:test";
import assert from "node:assert/strict";
import { helperContext } from "../agent/runtime/helpers.js";

test("page.request and fetch.profile expose a reusable bounded Response facade", async () => {
  const previousEgo = (globalThis as any).ego;
  const calls: any[] = [];
  (globalThis as any).ego = {
    profileRequest: async (...args: any[]) => {
      calls.push(args);
      return {
        status: 200,
        statusText: "OK",
        ok: true,
        url: "https://example.com/api/me",
        redirected: false,
        headers: [
          ["content-type", "application/json"],
          ["x-request", "profile"],
        ],
        bodyBase64: Buffer.from(JSON.stringify({ id: 42 })).toString("base64"),
        bytes: 9,
      };
    },
  };
  try {
    const helpers = helperContext();
    const response = await helpers.page.request("/api/me", {
      method: "POST",
      headers: { "x-csrf-token": "csrf-value" },
      json: { query: "profile" },
      timeoutMs: 2_500,
    });
    assert.equal(response.status, 200);
    assert.equal(response.header("Content-Type"), "application/json");
    assert.deepEqual(response.headers(), {
      "content-type": "application/json",
      "x-request": "profile",
    });
    assert.deepEqual(await response.json(), { id: 42 });
    assert.equal((await response.body()).toString(), '{"id":42}');
    assert.deepEqual(calls[0], [
      "/api/me",
      {
        method: "POST",
        timeoutMs: 2_500,
        headers: {
          "x-csrf-token": "csrf-value",
          "content-type": "application/json",
        },
        body: {
          encoding: "utf8",
          data: '{"query":"profile"}',
        },
      },
    ]);

    const alias = await helpers.fetch.profile("https://example.com/binary", {
      method: "PUT",
      body: Buffer.from([1, 2, 3]),
    });
    assert.equal(alias.ok, true);
    assert.deepEqual(calls[1][1].body, {
      encoding: "base64",
      data: "AQID",
    });
  } finally {
    (globalThis as any).ego = previousEgo;
  }
});
