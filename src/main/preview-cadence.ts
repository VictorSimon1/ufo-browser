export const OVERVIEW_PREVIEW_ACTIVE_WINDOW_MS = 4_000;

export function overviewSnapshotDelay(options: {
  visualChanged: boolean;
  unchangedSamples: number;
}) {
  const unchangedSamples = Math.max(
    0,
    Math.floor(options.unchangedSamples),
  );

  // Overview intentionally uses bounded screenshots instead of a continuous
  // compositor subscription. Dynamic cards are sampled often enough to show
  // progress, while settled cards back off so several visible Spaces do not
  // behave like several foreground browser windows.
  if (options.visualChanged) return 1_400;
  if (unchangedSamples < 2) return 1_800;
  if (unchangedSamples < 5) return 2_800;
  return 4_000;
}

export function overviewPreviewDelay(options: {
  unchangedFrames: number;
  millisecondsSinceActivity: number;
}) {
  const unchangedFrames = Math.max(0, Math.floor(options.unchangedFrames));
  const millisecondsSinceActivity = Math.max(
    0,
    Math.floor(options.millisecondsSinceActivity),
  );

  // Keep interaction feedback responsive for a short bounded window. Once a
  // page settles, progressively reduce forced compositor work instead of
  // invalidating an unchanged full-size Chromium surface every 450ms.
  if (millisecondsSinceActivity < OVERVIEW_PREVIEW_ACTIVE_WINDOW_MS) return 650;
  if (unchangedFrames === 0) return 900;
  if (unchangedFrames < 3) return 1_400;
  if (unchangedFrames < 7) return 2_000;
  return 2_800;
}

export function quantizedPreviewSignature(
  bitmap: Uint8Array,
  width: number,
  height: number,
) {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));
  const firstRow = safeHeight > 4 ? 1 : 0;
  const lastRow = safeHeight > 6 ? safeHeight - 3 : safeHeight;
  const signature = new Uint8Array(
    Math.max(0, safeWidth * Math.max(0, lastRow - firstRow) * 3),
  );
  let output = 0;
  for (let y = firstRow; y < lastRow; y++) {
    for (let x = 0; x < safeWidth; x++) {
      const input = (y * safeWidth + x) * 4;
      signature[output++] = (bitmap[input] ?? 0) >> 4;
      signature[output++] = (bitmap[input + 1] ?? 0) >> 4;
      signature[output++] = (bitmap[input + 2] ?? 0) >> 4;
    }
  }
  return signature;
}

export function previewVisualChanged(
  previous: Uint8Array | undefined,
  current: Uint8Array,
) {
  if (!previous || previous.length !== current.length) return true;
  const pixels = Math.floor(current.length / 3);
  let changedPixels = 0;
  for (let offset = 0; offset < current.length; offset += 3) {
    if (
      Math.abs(current[offset] - previous[offset]) > 1 ||
      Math.abs(current[offset + 1] - previous[offset + 1]) > 1 ||
      Math.abs(current[offset + 2] - previous[offset + 2]) > 1
    ) {
      changedPixels += 1;
    }
  }
  return changedPixels >= Math.max(2, Math.ceil(pixels * 0.005));
}
