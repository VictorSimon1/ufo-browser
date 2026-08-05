import test from "node:test";
import assert from "node:assert/strict";
import { SpaceLeaseRegistry } from "../main/space-lease.js";

test("only one connection can lease a space", () => {
  const leases = new SpaceLeaseRegistry();
  const first = leases.acquire(7, "a");
  assert.throws(() => leases.acquire(7, "b"), /UNAVAILABLE/);
  leases.assert(7, "a", first.generation);
  leases.release(7, "a");
  const second = leases.acquire(7, "b");
  assert.notEqual(second.generation, first.generation);
});

test("generation prevents commands from an expired lease", () => {
  const leases = new SpaceLeaseRegistry();
  const oldLease = leases.acquire(2, "a");
  leases.releaseConnection("a");
  leases.acquire(2, "a");
  assert.throws(
    () => leases.assert(2, "a", oldLease.generation),
    /UNAVAILABLE/,
  );
});
