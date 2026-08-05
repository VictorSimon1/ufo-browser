import test from "node:test";
import assert from "node:assert/strict";
import {
  OVERVIEW_PREVIEW_ACTIVE_WINDOW_MS,
  overviewPreviewDelay,
  previewVisualChanged,
  quantizedPreviewSignature,
} from "../main/preview-cadence.js";

test("Overview preview remains responsive during recent activity", () => {
  assert.equal(
    overviewPreviewDelay({
      unchangedFrames: 20,
      millisecondsSinceActivity: OVERVIEW_PREVIEW_ACTIVE_WINDOW_MS - 1,
    }),
    650,
  );
});

test("Overview preview backs off progressively when frames are unchanged", () => {
  const millisecondsSinceActivity = OVERVIEW_PREVIEW_ACTIVE_WINDOW_MS + 1;
  assert.deepEqual(
    [0, 1, 3, 7].map((unchangedFrames) =>
      overviewPreviewDelay({ unchangedFrames, millisecondsSinceActivity }),
    ),
    [900, 1_400, 2_000, 2_800],
  );
});

test("Overview preview cadence clamps invalid counters", () => {
  assert.equal(
    overviewPreviewDelay({ unchangedFrames: -5, millisecondsSinceActivity: -1 }),
    650,
  );
});

test("preview signatures ignore animated control chrome at the top and bottom", () => {
  const width = 8;
  const height = 8;
  const first = new Uint8Array(width * height * 4).fill(64);
  const second = first.slice();
  for (const y of [0, 5, 6, 7]) {
    for (let x = 0; x < width; x++) {
      second[(y * width + x) * 4] = 240;
    }
  }
  const firstSignature = quantizedPreviewSignature(first, width, height);
  const secondSignature = quantizedPreviewSignature(second, width, height);
  assert.equal(previewVisualChanged(firstSignature, secondSignature), false);
});

test("preview signatures detect small page-content changes", () => {
  const width = 24;
  const height = 16;
  const first = new Uint8Array(width * height * 4).fill(64);
  const second = first.slice();
  for (const [x, y] of [[10, 7], [11, 7]]) {
    const offset = (y * width + x) * 4;
    second[offset] = 224;
    second[offset + 1] = 224;
    second[offset + 2] = 224;
  }
  assert.equal(
    previewVisualChanged(
      quantizedPreviewSignature(first, width, height),
      quantizedPreviewSignature(second, width, height),
    ),
    true,
  );
});
