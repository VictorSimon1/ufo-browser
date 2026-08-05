import test from "node:test";
import assert from "node:assert/strict";
import {
  selectPreviewCaptureIds,
  visibleSpaceIds,
} from "../main/preview-visibility.js";

test("publishes only currently visible cards with a hard cap", () => {
  const cards = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    rect: { x: index * 100, y: 0, width: 90, height: 90 },
  }));
  assert.deepEqual(
    visibleSpaceIds(cards, { x: 0, y: 0, width: 2000, height: 2000 }),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.deepEqual(
    visibleSpaceIds(cards, { x: 350, y: 0, width: 160, height: 100 }),
    [4, 5, 6],
  );
});

test("preview capture selection allows at most one cold hydration", () => {
  assert.deepEqual(
    selectPreviewCaptureIds(
      [
        { id: 1, warm: false },
        { id: 2, warm: false },
        { id: 3, warm: true },
      ],
      2,
      1,
    ),
    [1, 3],
  );
  assert.deepEqual(
    selectPreviewCaptureIds(
      [
        { id: 1, warm: false },
        { id: 2, warm: true },
      ],
      2,
      0,
    ),
    [2],
  );
});
