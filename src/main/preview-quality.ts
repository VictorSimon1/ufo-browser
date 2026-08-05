export function bitmapHasVisualDetail(
  bitmap: Uint8Array,
  width: number,
  height: number,
) {
  const pixelCount = Math.min(
    Math.max(0, Math.floor(width) * Math.floor(height)),
    Math.floor(bitmap.byteLength / 4),
  );
  if (pixelCount < 16) return false;

  // Sampling roughly sixteen thousand pixels keeps the check cheap for Retina
  // captures while still finding small text, controls and logos on otherwise
  // flat pages. Channel order is intentionally irrelevant: averaging the
  // first three bytes works for both BGRA and RGBA bitmap layouts.
  const pixelStep = Math.max(1, Math.floor(pixelCount / 16_384));
  let samples = 0;
  let mean = 0;
  let squaredDelta = 0;
  let minimum = 255;
  let maximum = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += pixelStep) {
    const offset = pixel * 4;
    const value =
      (bitmap[offset] + bitmap[offset + 1] + bitmap[offset + 2]) / 3;
    samples += 1;
    const delta = value - mean;
    mean += delta / samples;
    squaredDelta += delta * (value - mean);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }

  if (samples < 16) return false;
  const deviation = Math.sqrt(squaredDelta / samples);
  const range = maximum - minimum;
  return deviation >= 3.2 || (range >= 26 && deviation >= 1.2);
}
