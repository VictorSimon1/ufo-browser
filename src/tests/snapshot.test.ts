import test from "node:test";
import assert from "node:assert/strict";
import { formatAxTree } from "../main/snapshot.js";

test("snapshot keeps backend DOM node ids as agent refs", () => {
  const refs: any[] = [];
  const content = formatAxTree(
    [
      { nodeId: "1", role: { value: "root" }, childIds: ["2"] },
      {
        nodeId: "2",
        backendDOMNodeId: 42,
        role: { value: "button" },
        name: { value: "Save" },
      },
    ],
    refs,
  );
  assert.match(content, /button "Save" \[ref=42/);
  assert.equal(refs[0].backendNodeId, 42);
});

test("snapshot refs retain iframe routing and collision-safe public ids", () => {
  const refs: any[] = [];
  const used = new Set([24]);
  const content = formatAxTree(
    [
      {
        nodeId: "1",
        backendDOMNodeId: 24,
        role: { value: "checkbox" },
        name: { value: "Verify you are human" },
      },
    ],
    refs,
    {
      frameId: "oopif-frame",
      refIdForBackendNodeId: (backendNodeId) =>
        used.has(backendNodeId) ? 1_000_000_000 : backendNodeId,
    },
  );
  assert.match(content, /checkbox "Verify you are human" \[ref=1000000000/);
  assert.equal(refs[0].backendNodeId, 24);
  assert.equal(refs[0].refId, 1_000_000_000);
  assert.equal(refs[0].frameId, "oopif-frame");
});
