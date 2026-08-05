import test from "node:test";
import assert from "node:assert/strict";
import { bitmapHasVisualDetail } from "../main/preview-quality.js";

function bitmap(width: number, height: number, value = 245) {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return data;
}

test("uniform and tiny-noise preview frames are treated as unfinished", () => {
  const frame = bitmap(160, 100);
  for (let offset = 0; offset < frame.length; offset += 64) {
    frame[offset] = 244;
  }
  assert.equal(bitmapHasVisualDetail(frame, 160, 100), false);
});

test("small text-like regions count as meaningful visual content", () => {
  const frame = bitmap(160, 100);
  for (let y = 20; y < 28; y++) {
    for (let x = 18; x < 92; x++) {
      const offset = (y * 160 + x) * 4;
      frame[offset] = 42;
      frame[offset + 1] = 42;
      frame[offset + 2] = 42;
    }
  }
  assert.equal(bitmapHasVisualDetail(frame, 160, 100), true);
});
