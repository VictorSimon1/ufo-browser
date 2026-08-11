// @ts-nocheck
import { parseRef, RefMap } from "./ref-map.js";

export const browserRefMap = new RefMap();

let refreshInflight: Promise<unknown> | null = null;
let snapshotImpl: (() => Promise<unknown>) | null = null;

export function registerSnapshotForRefRefresh(fn: () => Promise<unknown>) {
  snapshotImpl = fn;
}

export async function ensureRefMapForRef(selectorOrRef: unknown) {
  if (typeof selectorOrRef !== "string") return;
  const refId = parseRef(selectorOrRef);
  if (!refId) return;
  if (browserRefMap.get(refId)) return;
  const historical = await restoreHistoricalRef(refId);
  if (historical) return;
  if (browserRefMap.map.size > 0) return;
  await refreshSnapshot();
}

export function markBrowserRefsStale() {
  browserRefMap.markStale();
}

export async function refreshStaleRef(selectorOrRef: unknown) {
  if (typeof selectorOrRef !== "string") return false;
  const refId = parseRef(selectorOrRef);
  if (!refId) return false;
  const stale = browserRefMap.get(refId);
  await refreshSnapshot();
  const direct = browserRefMap.get(refId);
  if (!stale) return Boolean(direct);
  const candidates = [...browserRefMap.map.values()].filter((entry) =>
    sameStableTarget(stale, entry),
  );
  if (candidates.length !== 1) return false;
  browserRefMap.set(refId, { ...candidates[0], stale: false });
  return true;
}

async function refreshSnapshot() {
  if (!snapshotImpl) return;
  if (!refreshInflight) {
    refreshInflight = Promise.resolve(snapshotImpl()).finally(() => {
      refreshInflight = null;
    });
  }
  await refreshInflight;
}

async function restoreHistoricalRef(refId: string) {
  const resolveRef = (globalThis as any).ego?.resolveRef;
  if (typeof resolveRef !== "function") return false;
  const entry = await resolveRef(Number(refId));
  if (!entry || typeof entry !== "object") return false;
  if (entry.backendNodeId === undefined || entry.backendNodeId === null) {
    return false;
  }
  browserRefMap.addWithFrame(
    refId,
    entry.backendNodeId,
    entry.role,
    entry.name,
    entry.nth,
    entry.frameId,
    entry.loc,
  );
  return true;
}

function sameStableTarget(left, right) {
  if (left.selector && right.selector) {
    return left.selector === right.selector && sameFrameKind(left, right);
  }
  return (
    left.role === right.role &&
    left.name === right.name &&
    sameFrameKind(left, right)
  );
}

function sameFrameKind(left, right) {
  return Boolean(left.frameId) === Boolean(right.frameId);
}
