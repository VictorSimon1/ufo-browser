import test from "node:test";
import assert from "node:assert/strict";
import {
  createTemporarySessionScope,
  isTemporaryProfileId,
  TEMPORARY_AGENT_PROFILE_ID,
  TEMPORARY_PROFILE_ID,
  temporaryPublicProfile,
  temporarySessionPartition,
} from "../main/temporary-profile.js";

test("the temporary Profile is a built-in template with human and Agent ids", () => {
  assert.equal(isTemporaryProfileId(TEMPORARY_PROFILE_ID), true);
  assert.equal(isTemporaryProfileId(TEMPORARY_AGENT_PROFILE_ID), true);
  assert.equal(isTemporaryProfileId(" temporary "), true);
  assert.equal(isTemporaryProfileId("default"), false);
  assert.deepEqual(temporaryPublicProfile(), {
    id: "temporary",
    isDefault: false,
    name: "临时 Profile",
    kind: "temporary",
    ephemeral: true,
  });
});

test("every temporary Space receives a unique non-persistent partition", () => {
  const humanScope = createTemporarySessionScope();
  const agentScope = createTemporarySessionScope();
  const secondAgentScope = createTemporarySessionScope();
  const partitions = [humanScope, agentScope, secondAgentScope].map(
    temporarySessionPartition,
  );

  assert.equal(new Set(partitions).size, 3);
  for (const partition of partitions) {
    assert.match(partition, /^ufo-temporary-space-/);
    assert.equal(partition.startsWith("persist:"), false);
  }
});

test("malformed temporary Session scopes are rejected", () => {
  assert.throws(
    () => temporarySessionPartition("shared"),
    /invalid temporary Space session scope/,
  );
});
