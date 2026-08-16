import test from "node:test";
import assert from "node:assert/strict";
import { assertRawCdpPayload } from "../agent/raw-cdp.js";

test("raw CDP transport accepts its documented JSON envelope", () => {
  const payload = JSON.stringify({
    id: 7,
    method: "Browser.getVersion",
    params: {},
  });
  assert.equal(assertRawCdpPayload(payload), payload);
});

test("raw CDP transport rejects method-only strings before corrupting the stream", () => {
  assert.throws(
    () => assertRawCdpPayload("Runtime.evaluate"),
    /JSON\.stringify.*prefer cdp/,
  );
  assert.throws(
    () => assertRawCdpPayload(JSON.stringify({ method: "Runtime.evaluate" })),
    /payload must be JSON\.stringify/,
  );
});
