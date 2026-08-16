import type { WebContents, WebContentsView } from "electron";
import { TaskSpaceManager } from "./manager.js";
import { scopedChildTargets } from "./cdp-broker.js";

type AxValue = { value?: unknown };
type AxNode = {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  properties?: Array<{ name: string; value?: AxValue }>;
  childIds?: string[];
};

const ACTION_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
  "switch",
  "slider",
  "iframe",
]);

// AX roles such as dialog do not imply a literal HTML <dialog> element.
// Expose these structural roles as stable locators so agents can scope
// repeated controls without guessing DOM tag names.
const STRUCTURAL_LOCATOR_ROLES = new Set([
  "dialog",
  "alertdialog",
  "region",
  "main",
  "form",
]);

type SnapshotRef = {
  refId?: number;
  backendNodeId: number;
  role: string;
  name: string;
  loc?: string;
  frameId?: string;
  matchCount?: number;
  matchIndex?: number;
  box?: { x: number; y: number; width: number; height: number };
};

export type SnapshotOptions = {
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
  scope?: "only_within_viewport" | "full_page";
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  urls?: boolean;
  boxes?: boolean;
  sinceRevision?: string;
};

type SnapshotVersion = {
  documentId: string;
  generation: number;
};

type CachedSnapshot = {
  version: SnapshotVersion;
  optionsKey: string;
  content: string;
  refs: SnapshotRef[];
  revision: string;
  coverageComplete: boolean;
};

type SnapshotDelta = {
  content: string;
  changed: number;
  added: number;
  removed: number;
  tooLarge: boolean;
};

export const SNAPSHOT_HISTORY_LIMIT = 12;
export const SNAPSHOT_REF_HISTORY_LIMIT = 4_096;
export const SNAPSHOT_SELECTOR_MATCH_LIMIT = 2_000;
export const SNAPSHOT_BOX_LIMIT = 2_000;
const SNAPSHOT_MAX_RESULT_LENGTH = 10_000_000;
const SNAPSHOT_SENSITIVE_URL_PARAM =
  /pass(word)?|secret|token|authorization|cookie|set-cookie|otp|pin|credential|api[-_]?key|card|cvv/i;
const SNAPSHOT_SENSITIVE_TEXT =
  /(bearer\s+[a-z0-9._~+/=-]+|(?:password|secret|token|otp|pin|authorization|cookie)\s*[:=]\s*[^\s,;]+)/gi;

const SNAPSHOT_VERSION_SOURCE = `(() => {
  const key = Symbol.for("ufo-browser.snapshot-state");
  let state = globalThis[key];
  if (!state || state.document !== document) {
    state = {
      document,
      documentId: globalThis.crypto?.randomUUID?.() || String(performance.timeOrigin),
      generation: 0,
    };
    const changed = () => { state.generation += 1; };
    state.observer = new MutationObserver(changed);
    state.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    document.addEventListener("load", (event) => {
      if (event.target?.tagName === "IFRAME") changed();
    }, true);
    document.addEventListener("input", changed, true);
    document.addEventListener("change", changed, true);
    document.addEventListener("scroll", changed, { capture: true, passive: true });
    globalThis.addEventListener("resize", changed, { passive: true });
    Object.defineProperty(globalThis, key, {
      value: state,
      configurable: true,
    });
  }
  return { documentId: state.documentId, generation: state.generation };
})()`;

export class SnapshotService {
  private readonly accessibilityEnabled = new WeakSet<WebContents>();
  private readonly cache = new WeakMap<WebContents, CachedSnapshot>();
  private readonly history = new WeakMap<WebContents, Map<string, CachedSnapshot>>();
  private readonly refHistory = new WeakMap<
    WebContents,
    Map<number, SnapshotRef>
  >();

  constructor(private readonly manager: TaskSpaceManager) {}

  async snapshot(
    spaceId: number,
    rawOptions: SnapshotOptions = {},
  ) {
    const options = normalizeSnapshotOptions(rawOptions);
    const tab = this.manager.getActiveTab(spaceId);
    const view = await this.manager.ensureTabRuntime(spaceId, tab.targetId);
    if (options.scope === "only_within_viewport") {
      // A never-presented background page can legitimately report a 0x0
      // viewport while its AX tree remains readable. Mount it only on the
      // hidden capture surface for this explicit viewport request; it never
      // enters the main window or changes Presentation.
      await this.manager.ensureBackgroundSurface(spaceId, tab.targetId, false);
    }
    if (!view.webContents.debugger.isAttached()) {
      view.webContents.debugger.attach("1.3");
      this.accessibilityEnabled.delete(view.webContents);
    }
    const optionsKey = snapshotOptionsKey(options);
    let version = await readSnapshotVersion(view.webContents).catch(
      () => undefined,
    );
    const cached = this.cache.get(view.webContents);
    if (
      version &&
      cached?.optionsKey === optionsKey &&
      sameSnapshotVersion(cached.version, version)
    ) {
      const result = this.snapshotResult(view.webContents, cached, options);
      this.rememberRefs(view.webContents, result.refs);
      return result;
    }

    let captured = await this.capture(view, options);
    let after = await readSnapshotVersion(view.webContents).catch(
      () => undefined,
    );
    if (version && after && !sameSnapshotVersion(version, after)) {
      version = after;
      captured = await this.capture(view, options);
      after = await readSnapshotVersion(view.webContents).catch(
        () => undefined,
      );
    }
    const stableVersion = after ?? version;
    const revision = snapshotRevision(stableVersion, captured.content);
    const entry: CachedSnapshot = {
      version: stableVersion ?? { documentId: "unknown", generation: 0 },
      optionsKey,
      content: captured.content,
      refs: captured.refs,
      revision,
      coverageComplete: captured.coverageComplete,
    };
    if (
      !captured.hasChildTargets &&
      options.scope !== "only_within_viewport" &&
      !options.boxes &&
      version &&
      after &&
      sameSnapshotVersion(version, after)
    ) {
      this.cache.set(view.webContents, {
        ...entry,
        version: after,
      });
    } else {
      this.cache.delete(view.webContents);
    }
    this.rememberSnapshot(view.webContents, entry);
    const result = this.snapshotResult(view.webContents, entry, options);
    this.rememberRefs(view.webContents, result.refs);
    return result;
  }

  async resolveHistoricalRef(spaceId: number, refId: number) {
    if (!Number.isSafeInteger(refId) || refId <= 0) {
      throw new Error(`EGO_INVALID_ARGUMENT: invalid ref ${refId}`);
    }
    const tab = this.manager.getActiveTab(spaceId);
    const view = await this.manager.ensureTabRuntime(spaceId, tab.targetId);
    const stale = this.refHistory.get(view.webContents)?.get(refId);
    if (!stale) return null;

    const current = await this.snapshot(spaceId, {
      includeActionMarks: true,
      includeStableLocator: true,
    });
    let candidates = stale.loc
      ? current.refs.filter(
          (candidate) =>
            candidate.loc === stale.loc &&
            Boolean(candidate.frameId) === Boolean(stale.frameId),
        )
      : [];
    if (candidates.length === 0) {
      candidates = current.refs.filter(
        (candidate) =>
          candidate.role === stale.role &&
          candidate.name === stale.name &&
          Boolean(candidate.frameId) === Boolean(stale.frameId),
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `EGO_STALE_REF_AMBIGUOUS: stale ref @${refId} (${stale.role} ${JSON.stringify(stale.name)}) matched ${candidates.length} elements after refresh`,
      );
    }
    const candidate = candidates[0];
    if (!candidate) return null;
    const recovered = { ...candidate, refId };
    this.rememberRefs(view.webContents, [recovered]);
    return recovered;
  }

  private async capture(view: WebContentsView, options: SnapshotOptions) {
    if (!this.accessibilityEnabled.has(view.webContents)) {
      await view.webContents.debugger.sendCommand("Accessibility.enable");
      this.accessibilityEnabled.add(view.webContents);
    }
    const result = (await view.webContents.debugger.sendCommand(
      "Accessibility.getFullAXTree",
    )) as { nodes: AxNode[] };
    const rootBackendNodeIds = options.selector
      ? await querySelectorBackendNodeIds(view.webContents, options.selector)
      : undefined;
    const visibleBackendNodeIds =
      options.scope === "only_within_viewport"
        ? await queryViewportBackendNodeIds(view.webContents)
        : undefined;
    const refs: SnapshotRef[] = [];
    let rootContent = formatAxTree(result.nodes ?? [], refs, {
      ...options,
      rootBackendNodeIds,
      visibleBackendNodeIds,
    });
    if (options.boxes) {
      assertBoxLookupLimit(refs);
      await addRefBoxes(view.webContents, refs);
      rootContent = annotateBoxes(rootContent, refs);
    }
    const usedRefIds = new Set(
      (result.nodes ?? [])
        .filter(
          (node) =>
            typeof node.backendDOMNodeId === "number" &&
            ACTION_ROLES.has(String(node.role?.value || "").toLowerCase()),
        )
        .map((node) => node.backendDOMNodeId!),
    );
    const childSections: string[] = [];
    let coverageComplete = true;

    const childTargets = options.selector
      ? []
      : await scopedChildTargets(view.webContents);
    for (const target of childTargets) {
      let upstreamSessionId: string | undefined;
      try {
        const attached = await view.webContents.debugger.sendCommand(
          "Target.attachToTarget",
          { targetId: target.targetId, flatten: true },
        );
        upstreamSessionId = attached.sessionId;
        await view.webContents.debugger.sendCommand(
          "Accessibility.enable",
          {},
          upstreamSessionId,
        );
        const childResult = (await view.webContents.debugger.sendCommand(
          "Accessibility.getFullAXTree",
          {},
          upstreamSessionId,
        )) as { nodes: AxNode[] };
        const childRefs: SnapshotRef[] = [];
        const childVisibleBackendNodeIds =
          options.scope === "only_within_viewport"
            ? await queryViewportBackendNodeIds(
                view.webContents,
                upstreamSessionId,
              )
            : undefined;
        let childContent = formatAxTree(childResult.nodes ?? [], childRefs, {
          ...options,
          includeStableLocator: false,
          frameId: target.targetId,
          visibleBackendNodeIds: childVisibleBackendNodeIds,
          refIdForBackendNodeId: (backendNodeId) => {
            if (!usedRefIds.has(backendNodeId)) {
              usedRefIds.add(backendNodeId);
              return backendNodeId;
            }
            const refId = collisionSafeFrameRef(
              target.targetId,
              backendNodeId,
              usedRefIds,
            );
            usedRefIds.add(refId);
            return refId;
          },
        });
        if (options.boxes) {
          assertBoxLookupLimit(childRefs);
          await addRefBoxes(view.webContents, childRefs, upstreamSessionId);
          childContent = annotateBoxes(childContent, childRefs);
        }
        refs.push(...childRefs);
        if (childContent) {
          const label = target.title || target.url || target.targetId;
          childSections.push(
            `iframe ${JSON.stringify(label)}\n${indent(childContent, 1)}`,
          );
        }
      } catch {
        // A child frame may navigate or disappear while its AX tree is read.
        coverageComplete = false;
      } finally {
        if (upstreamSessionId) {
          try {
            await view.webContents.debugger.sendCommand(
              "Target.detachFromTarget",
              { sessionId: upstreamSessionId },
            );
          } catch {
            // The target may already be gone after navigation.
          }
        }
      }
    }
    const content = [rootContent, ...childSections].filter(Boolean).join("\n");
    return {
      content,
      refs,
      hasChildTargets: childTargets.length > 0,
      coverageComplete,
    };
  }

  private rememberRefs(webContents: WebContents, refs: SnapshotRef[]) {
    let history = this.refHistory.get(webContents);
    if (!history) {
      history = new Map();
      this.refHistory.set(webContents, history);
    }
    for (const ref of refs) {
      const refId = ref.refId ?? ref.backendNodeId;
      if (!Number.isSafeInteger(refId) || refId <= 0) continue;
      history.delete(refId);
      history.set(refId, { ...ref, refId });
    }
    while (history.size > SNAPSHOT_REF_HISTORY_LIMIT) {
      const oldest = history.keys().next().value;
      if (oldest === undefined) break;
      history.delete(oldest);
    }
  }

  private rememberSnapshot(webContents: WebContents, snapshot: CachedSnapshot) {
    let history = this.history.get(webContents);
    if (!history) {
      history = new Map();
      this.history.set(webContents, history);
    }
    const key = snapshotHistoryKey(snapshot.revision, snapshot.optionsKey);
    history.delete(key);
    history.set(key, cloneSnapshot(snapshot));
    while (history.size > SNAPSHOT_HISTORY_LIMIT) {
      const oldest = history.keys().next().value;
      if (oldest === undefined) break;
      history.delete(oldest);
    }
  }

  private snapshotResult(
    webContents: WebContents,
    snapshot: CachedSnapshot,
    options: SnapshotOptions,
  ) {
    const baseline = options.sinceRevision
      ? this.history
          .get(webContents)
          ?.get(snapshotHistoryKey(options.sinceRevision, snapshot.optionsKey))
      : undefined;
    let content = snapshot.content;
    let kind: "full" | "delta" = "full";
    let fallbackReason: string | undefined;
    let changes:
      | { changed: number; added: number; removed: number }
      | undefined;
    if (options.sinceRevision) {
      if (!baseline) {
        fallbackReason = "baseline-unavailable";
      } else if (baseline.version.documentId !== snapshot.version.documentId) {
        fallbackReason = "document-changed";
      } else if (!baseline.coverageComplete || !snapshot.coverageComplete) {
        fallbackReason = "frame-coverage-incomplete";
      } else {
        const delta = diffSnapshotContent(
          baseline.content,
          snapshot.content,
          baseline.revision,
          snapshot.revision,
        );
        if (delta.tooLarge) {
          fallbackReason = "change-set-too-large";
        } else {
          kind = "delta";
          content = delta.content;
          changes = {
            changed: delta.changed,
            added: delta.added,
            removed: delta.removed,
          };
        }
      }
    }
    return {
      content:
        typeof options.maxResultLength === "number"
          ? content.slice(0, options.maxResultLength)
          : content,
      refs: snapshot.refs.map((ref) => ({
        ...ref,
        box: ref.box && { ...ref.box },
      })),
      revision: snapshot.revision,
      kind,
      baseRevision: kind === "delta" ? options.sinceRevision : undefined,
      fallbackReason,
      changes,
    };
  }
}

async function readSnapshotVersion(webContents: WebContents) {
  const response = await webContents.debugger.sendCommand("Runtime.evaluate", {
    expression: SNAPSHOT_VERSION_SOURCE,
    returnByValue: true,
    awaitPromise: false,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "snapshot version evaluation failed",
    );
  }
  const value = response.result?.value;
  if (
    typeof value?.documentId !== "string" ||
    !Number.isSafeInteger(value?.generation)
  ) {
    throw new Error("snapshot version evaluation returned an invalid value");
  }
  return value as SnapshotVersion;
}

function sameSnapshotVersion(left: SnapshotVersion, right: SnapshotVersion) {
  return (
    left.documentId === right.documentId &&
    left.generation === right.generation
  );
}

function snapshotOptionsKey(options: SnapshotOptions) {
  return JSON.stringify({
    actionMarks: options.includeActionMarks !== false,
    stableLocator: options.includeStableLocator !== false,
    scope: options.scope ?? "full_page",
    interactive: options.interactive === true,
    compact: options.compact === true,
    depth: options.depth,
    selector: options.selector,
    urls: options.urls === true,
    boxes: options.boxes === true,
  });
}

function normalizeSnapshotOptions(value: SnapshotOptions) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("EGO_INVALID_ARGUMENT: snapshot options must be an object");
  }
  const depth = value.depth;
  if (
    depth !== undefined &&
    (!Number.isSafeInteger(depth) || depth < 0 || depth > 64)
  ) {
    throw new TypeError("EGO_INVALID_ARGUMENT: snapshot depth must be an integer from 0 to 64");
  }
  const selector = value.selector?.trim();
  if (selector !== undefined && (!selector || selector.length > 2_048)) {
    throw new TypeError("EGO_INVALID_ARGUMENT: snapshot selector is invalid");
  }
  const sinceRevision = value.sinceRevision?.trim();
  if (
    sinceRevision !== undefined &&
    (!sinceRevision || sinceRevision.length > 512)
  ) {
    throw new TypeError("EGO_INVALID_ARGUMENT: snapshot revision is invalid");
  }
  if (
    value.scope !== undefined &&
    value.scope !== "full_page" &&
    value.scope !== "only_within_viewport"
  ) {
    throw new TypeError("EGO_INVALID_ARGUMENT: snapshot scope is invalid");
  }
  const maxResultLength = value.maxResultLength;
  if (
    maxResultLength !== undefined &&
    (!Number.isSafeInteger(maxResultLength) ||
      maxResultLength < 0 ||
      maxResultLength > SNAPSHOT_MAX_RESULT_LENGTH)
  ) {
    throw new TypeError(
      `EGO_INVALID_ARGUMENT: snapshot maxResultLength must be an integer from 0 to ${SNAPSHOT_MAX_RESULT_LENGTH}`,
    );
  }
  return {
    ...value,
    depth,
    selector,
    sinceRevision,
    maxResultLength,
  };
}

function snapshotRevision(version: SnapshotVersion | undefined, content: string) {
  const documentId = version?.documentId ?? "unknown";
  const generation = version?.generation ?? 0;
  return `${documentId}:${generation}:${hashText(content).toString(36)}`;
}

function snapshotHistoryKey(revision: string, optionsKey: string) {
  return `${revision}\u0000${optionsKey}`;
}

function cloneSnapshot(snapshot: CachedSnapshot): CachedSnapshot {
  return {
    ...snapshot,
    version: { ...snapshot.version },
    refs: snapshot.refs.map((ref) => ({
      ...ref,
      box: ref.box && { ...ref.box },
    })),
  };
}

export function diffSnapshotContent(
  before: string,
  after: string,
  beforeRevision: string,
  afterRevision: string,
): SnapshotDelta {
  const beforeLines = before ? before.split("\n") : [];
  const afterLines = after ? after.split("\n") : [];
  const beforeStable = stableLines(beforeLines);
  const afterStable = stableLines(afterLines);
  const changed: Array<{ before: string; after: string }> = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [key, line] of beforeStable) {
    const next = afterStable.get(key);
    if (next === undefined) removed.push(line);
    else if (next !== line) changed.push({ before: line, after: next });
  }
  for (const [key, line] of afterStable) {
    if (!beforeStable.has(key)) added.push(line);
  }
  diffAnonymousLines(beforeLines, afterLines, added, removed);
  const changeCount = changed.length + added.length + removed.length;
  const total = Math.max(beforeLines.length, afterLines.length, 1);
  const tooLarge = changeCount > 200 || (total > 20 && changeCount / total > 0.6);
  const lines = [`revision: ${beforeRevision} -> ${afterRevision}`];
  if (changed.length) {
    lines.push("", "changed:");
    for (const pair of changed) lines.push(`- ${pair.before}`, `+ ${pair.after}`);
  }
  if (added.length) {
    lines.push("", "added:", ...added.map((line) => `+ ${line}`));
  }
  if (removed.length) {
    lines.push("", "removed:", ...removed.map((line) => `- ${line}`));
  }
  if (changeCount === 0) lines.push("", "no changes");
  return {
    content: lines.join("\n").replace(SNAPSHOT_SENSITIVE_TEXT, "[redacted]"),
    changed: changed.length,
    added: added.length,
    removed: removed.length,
    tooLarge,
  };
}

function stableLines(lines: string[]) {
  const output = new Map<string, string>();
  for (const line of lines) {
    const key = stableLineKey(line);
    if (key) output.set(key, line);
  }
  return output;
}

function stableLineKey(line: string) {
  const ref = line.match(/\[ref=(\d+)/)?.[1];
  if (ref) return `ref:${ref}`;
  const marker = line.lastIndexOf(" [loc=");
  const loc =
    marker >= 0 && line.endsWith("]")
      ? line.slice(marker + " [loc=".length, -1)
      : undefined;
  if (loc && !loc.includes("ambiguous")) return `loc:${loc}`;
  return undefined;
}

function diffAnonymousLines(
  beforeLines: string[],
  afterLines: string[],
  added: string[],
  removed: string[],
) {
  const beforeCounts = lineCounts(
    beforeLines.filter((line) => !stableLineKey(line)),
  );
  const afterCounts = lineCounts(
    afterLines.filter((line) => !stableLineKey(line)),
  );
  for (const [line, count] of beforeCounts) {
    const difference = count - (afterCounts.get(line) ?? 0);
    for (let index = 0; index < difference; index += 1) removed.push(line);
  }
  for (const [line, count] of afterCounts) {
    const difference = count - (beforeCounts.get(line) ?? 0);
    for (let index = 0; index < difference; index += 1) added.push(line);
  }
}

function lineCounts(lines: string[]) {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

function hashText(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

async function querySelectorBackendNodeIds(
  webContents: WebContents,
  selector: string,
) {
  try {
    const document = await webContents.debugger.sendCommand("DOM.getDocument", {
      depth: 0,
      pierce: true,
    });
    const matches = await webContents.debugger.sendCommand("DOM.querySelectorAll", {
      nodeId: document.root.nodeId,
      selector,
    });
    const nodeIds = matches.nodeIds ?? [];
    if (nodeIds.length > SNAPSHOT_SELECTOR_MATCH_LIMIT) {
      throw new Error(
        `selector matched more than ${SNAPSHOT_SELECTOR_MATCH_LIMIT} nodes`,
      );
    }
    const backendIds = await mapWithConcurrency(nodeIds, 12, async (nodeId) => {
      const described = await webContents.debugger.sendCommand("DOM.describeNode", {
        nodeId,
        depth: 0,
      });
      return Number(described.node?.backendNodeId);
    });
    return new Set(
      backendIds.filter((id) => Number.isSafeInteger(id) && id > 0),
    );
  } catch (error: any) {
    throw new Error(
      `EGO_INVALID_ARGUMENT: snapshot selector failed: ${error?.message || String(error)}`,
    );
  }
}

async function queryViewportBackendNodeIds(
  webContents: WebContents,
  sessionId?: string,
) {
  let viewport: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const metrics = await webContents.debugger.sendCommand(
      "Page.getLayoutMetrics",
      {},
      sessionId,
    );
    const layout = metrics.layoutViewport ?? {};
    const cssLayout = metrics.cssLayoutViewport ?? {};
    viewport =
      Number(layout.clientWidth) > 0 && Number(layout.clientHeight) > 0
        ? layout
        : cssLayout;
    if (
      Number(viewport.clientWidth) > 0 &&
      Number(viewport.clientHeight) > 0
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  if (
    !(Number(viewport.clientWidth) > 0) ||
    !(Number(viewport.clientHeight) > 0)
  ) {
    throw new Error("EGO_SNAPSHOT_FAILED: viewport is unavailable");
  }
  const snapshot = await webContents.debugger.sendCommand(
    "DOMSnapshot.captureSnapshot",
    {
      computedStyles: [],
      includeDOMRects: true,
      includePaintOrder: false,
    },
    sessionId,
  );
  // DOMSnapshot bounds use layout coordinates. Electron's layoutViewport is
  // device-scaled on Retina displays; cssLayoutViewport is the fallback only
  // when Chromium omits the legacy layout viewport.
  const x = Number(viewport.pageX ?? 0);
  const y = Number(viewport.pageY ?? 0);
  const width = Number(viewport.clientWidth ?? 0);
  const height = Number(viewport.clientHeight ?? 0);
  if (!(width > 0 && height > 0)) return new Set<number>();
  const visible = new Set<number>();
  for (const document of snapshot.documents ?? []) {
    const backendNodeIds = document.nodes?.backendNodeId ?? [];
    const nodeIndexes = document.layout?.nodeIndex ?? [];
    const bounds = document.layout?.bounds ?? [];
    for (let index = 0; index < nodeIndexes.length; index += 1) {
      const nodeIndex = Number(nodeIndexes[index]);
      const backendNodeId = Number(backendNodeIds[nodeIndex]);
      const rect = bounds[index];
      if (
        !Number.isSafeInteger(backendNodeId) ||
        backendNodeId <= 0 ||
        !Array.isArray(rect) ||
        rect.length < 4
      ) {
        continue;
      }
      const [left, top, rectWidth, rectHeight] = rect.map(Number);
      if (
        rectWidth > 0 &&
        rectHeight > 0 &&
        left < x + width &&
        left + rectWidth > x &&
        top < y + height &&
        top + rectHeight > y
      ) {
        visible.add(backendNodeId);
      }
    }
  }
  return visible;
}

async function addRefBoxes(
  webContents: WebContents,
  refs: SnapshotRef[],
  sessionId?: string,
) {
  await mapWithConcurrency(refs, 8, async (ref) => {
    try {
      const result = await webContents.debugger.sendCommand(
        "DOM.getBoxModel",
        { backendNodeId: ref.backendNodeId },
        sessionId,
      );
      const quad = result.model?.border ?? result.model?.content;
      if (!Array.isArray(quad) || quad.length < 8) return;
      const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
      const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      ref.box = {
        x: rounded(x),
        y: rounded(y),
        width: rounded(Math.max(...xs) - x),
        height: rounded(Math.max(...ys) - y),
      };
    } catch {
      // Hidden, detached, or virtual AX nodes may not have a layout box.
    }
  });
}

function assertBoxLookupLimit(refs: SnapshotRef[]) {
  if (refs.length > SNAPSHOT_BOX_LIMIT) {
    throw new Error(
      `EGO_SNAPSHOT_FAILED: boxes are limited to ${SNAPSHOT_BOX_LIMIT} refs`,
    );
  }
}

function annotateBoxes(content: string, refs: SnapshotRef[]) {
  let output = content;
  for (const ref of refs) {
    if (!ref.box) continue;
    const refId = ref.refId ?? ref.backendNodeId;
    const marker = `[ref=${refId}`;
    output = output.replace(
      marker,
      `${marker}, box=${ref.box.x},${ref.box.y},${ref.box.width},${ref.box.height}`,
    );
  }
  return output;
}

export function collisionSafeFrameRef(
  frameId: string,
  backendNodeId: number,
  used: Set<number>,
) {
  let candidate =
    1_000_000_000 +
    (hashText(`${frameId}:${backendNodeId}`) % 1_000_000_000);
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await operation(values[index]);
      }
    }),
  );
  return results;
}

function rounded(value: number) {
  return Math.round(value * 10) / 10;
}

export function formatAxTree(
  nodes: AxNode[],
  refs: SnapshotRef[],
  options: {
    includeActionMarks?: boolean;
    includeStableLocator?: boolean;
    frameId?: string;
    refIdForBackendNodeId?: (backendNodeId: number) => number;
    interactive?: boolean;
    compact?: boolean;
    depth?: number;
    urls?: boolean;
    rootBackendNodeIds?: Set<number>;
    visibleBackendNodeIds?: Set<number>;
  } = {},
) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const documentRoots = nodes.filter((node) => !childIds.has(node.nodeId));
  const roots = options.rootBackendNodeIds
    ? nodes.filter(
        (node) =>
          typeof node.backendDOMNodeId === "number" &&
          options.rootBackendNodeIds!.has(node.backendDOMNodeId),
      )
    : documentRoots;
  const locatorCounts = countStableLocators(documentRoots, byId);
  const locatorOccurrences = new Map<string, number>();
  const lines: string[] = [];
  const visibilityMemo = new Map<string, boolean>();
  const isInScope = (node: AxNode): boolean => {
    if (!options.visibleBackendNodeIds) return true;
    const cached = visibilityMemo.get(node.nodeId);
    if (cached !== undefined) return cached;
    // Seed before recursion so a malformed AX cycle cannot recurse forever.
    visibilityMemo.set(node.nodeId, false);
    const ownVisible =
      typeof node.backendDOMNodeId === "number" &&
      options.visibleBackendNodeIds.has(node.backendDOMNodeId);
    const descendantVisible = (node.childIds ?? []).some((id) => {
      const child = byId.get(id);
      return child ? isInScope(child) : false;
    });
    const visible = ownVisible || descendantVisible;
    visibilityMemo.set(node.nodeId, visible);
    return visible;
  };
  const visit = (node: AxNode, depth: number, insideFrame = false) => {
    if (!isInScope(node)) return;
    if (node.ignored) {
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) visit(child, depth, insideFrame);
      }
      return;
    }
    const role = String(node.role?.value || "container");
    const name = String(node.name?.value || "").trim();
    const actionable =
      ACTION_ROLES.has(role.toLowerCase()) &&
      typeof node.backendDOMNodeId === "number";
    const structural = STRUCTURAL_LOCATOR_ROLES.has(role.toLowerCase());
    const compactText =
      Boolean(name) &&
      !["generic", "none", "container", "rootwebarea"].includes(
        role.toLowerCase(),
      );
    const emit = options.interactive
      ? actionable || structural
      : options.compact
        ? actionable || structural || compactText
        : true;
    const locatorEligible =
      !insideFrame &&
      options.includeStableLocator !== false &&
      (actionable || STRUCTURAL_LOCATOR_ROLES.has(role.toLowerCase()));
    const candidate = locatorEligible ? stableLocator(role, name, node) : undefined;
    const matchCount = candidate ? locatorCounts.get(candidate) ?? 0 : 0;
    const matchIndex = candidate
      ? (locatorOccurrences.set(
          candidate,
          (locatorOccurrences.get(candidate) ?? 0) + 1,
        ), (locatorOccurrences.get(candidate) ?? 1) - 1)
      : undefined;
    const locator = candidate && matchCount === 1 ? candidate : undefined;
    let suffix = "";
    if (actionable && options.includeActionMarks !== false) {
      const refId = options.refIdForBackendNodeId
        ? options.refIdForBackendNodeId(node.backendDOMNodeId!)
        : node.backendDOMNodeId!;
      suffix += ` [ref=${refId}`;
      if (locator) suffix += `, loc=${locator}`;
      else if (candidate && matchCount > 1) {
        suffix += `, loc=ambiguous, hint=use nth(${matchIndex}) of ${matchCount}`;
      }
      if (options.urls && role.toLowerCase() === "link") {
        const url = node.properties?.find((property) => property.name === "url")
          ?.value?.value;
        if (typeof url === "string") {
          suffix += `, url=${JSON.stringify(sanitizeSnapshotUrl(url).value)}`;
        }
      }
      suffix += "]";
      refs.push({
        refId,
        backendNodeId: node.backendDOMNodeId!,
        role,
        name,
        loc: locator,
        frameId: options.frameId,
        matchCount: matchCount || undefined,
        matchIndex,
      });
    }
    if (!actionable && candidate) {
      if (locator) suffix = ` [loc=${locator}]`;
      else if (matchCount > 1) {
        suffix = ` [loc=ambiguous, hint=use a narrower ${role} locator]`;
      }
    }
    const label = name ? `${role} ${JSON.stringify(name)}` : role;
    let childDepth = depth;
    if (emit && label !== "generic" && label !== "none") {
      lines.push(`${"  ".repeat(depth)}${label}${suffix}`);
      childDepth += 1;
    }
    if (
      typeof options.depth === "number" &&
      emit &&
      childDepth > options.depth
    ) {
      return;
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) {
        visit(
          child,
          childDepth,
          insideFrame || role.toLowerCase() === "iframe",
        );
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return lines.join("\n");
}

function countStableLocators(roots: AxNode[], byId: Map<string, AxNode>) {
  const counts = new Map<string, number>();
  const visit = (node: AxNode, insideFrame = false) => {
    const role = String(node.role?.value || "container");
    const name = String(node.name?.value || "").trim();
    if (
      !node.ignored &&
      !insideFrame &&
      (ACTION_ROLES.has(role.toLowerCase()) ||
        STRUCTURAL_LOCATOR_ROLES.has(role.toLowerCase()))
    ) {
      const locator = stableLocator(role, name, node);
      if (locator) counts.set(locator, (counts.get(locator) || 0) + 1);
    }
    const childInsideFrame = insideFrame || role.toLowerCase() === "iframe";
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, childInsideFrame);
    }
  };
  for (const root of roots) visit(root);
  return counts;
}

function indent(content: string, depth: number) {
  const prefix = "  ".repeat(depth);
  return content
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function stableLocator(role: string, name: string, node: AxNode) {
  const url = node.properties?.find((property) => property.name === "url")?.value
    ?.value;
  if (role === "link" && typeof url === "string") {
    const safe = sanitizeSnapshotUrl(url);
    if (!safe.redacted) return `href:${url}`;
  }
  if (name) return `role:${role}[name=${JSON.stringify(name)}]`;
  if (STRUCTURAL_LOCATOR_ROLES.has(role.toLowerCase())) return `role:${role}`;
  return undefined;
}

function sanitizeSnapshotUrl(value: string) {
  try {
    const url = new URL(value);
    let redacted = Boolean(url.username || url.password);
    url.username = "";
    url.password = "";
    for (const [name] of url.searchParams) {
      if (!SNAPSHOT_SENSITIVE_URL_PARAM.test(name)) continue;
      url.searchParams.set(name, "[redacted]");
      redacted = true;
    }
    return { value: redacted ? url.toString() : value, redacted };
  } catch {
    const redacted = SNAPSHOT_SENSITIVE_URL_PARAM.test(value);
    return { value: redacted ? "[redacted-url]" : value, redacted };
  }
}
