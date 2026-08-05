import { parseRef, RefMap } from "./ref-map.js";

export const browserRefMap = new RefMap();

let ensuring = false;
let snapshotImpl: (() => Promise<unknown>) | null = null;

export function registerSnapshotForRefRefresh(fn: () => Promise<unknown>) {
  snapshotImpl = fn;
}

export async function ensureRefMapForRef(selectorOrRef: unknown) {
  if (ensuring) return;
  if (typeof selectorOrRef !== "string") return;
  if (!parseRef(selectorOrRef)) return;
  if (browserRefMap.map.size > 0) return;
  if (!snapshotImpl) return;
  ensuring = true;
  try {
    await snapshotImpl();
  } finally {
    ensuring = false;
  }
}
