import type { Rect } from "./types.js";

export type PreviewCaptureCandidate = {
  id: number;
  warm: boolean;
};

export function visibleSpaceIds(
  cards: Array<{ id: number; rect: Rect }>,
  viewport: Rect,
  limit = 8,
) {
  return cards
    .filter(({ rect }) => intersects(rect, viewport))
    .slice(0, limit)
    .map(({ id }) => id);
}

export function selectPreviewCaptureIds(
  candidates: PreviewCaptureCandidate[],
  slots: number,
  coldSlots: number,
) {
  const selected: number[] = [];
  let remainingCold = Math.max(0, coldSlots);
  for (const candidate of candidates) {
    if (selected.length >= Math.max(0, slots)) break;
    if (!candidate.warm) {
      if (remainingCold <= 0) continue;
      remainingCold -= 1;
    }
    selected.push(candidate.id);
  }
  return selected;
}

function intersects(a: Rect, b: Rect) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
