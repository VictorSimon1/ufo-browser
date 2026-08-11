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

type SnapshotRef = {
  refId?: number;
  backendNodeId: number;
  role: string;
  name: string;
  loc?: string;
  frameId?: string;
};

type SnapshotOptions = {
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
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
};

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
  private readonly refHistory = new WeakMap<
    WebContents,
    Map<number, SnapshotRef>
  >();

  constructor(private readonly manager: TaskSpaceManager) {}

  async snapshot(
    spaceId: number,
    options: SnapshotOptions = {},
  ) {
    const tab = this.manager.getActiveTab(spaceId);
    const view = await this.manager.ensureTabRuntime(spaceId, tab.targetId);
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
      const result = snapshotResult(cached.content, cached.refs, options);
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
    if (
      !captured.hasChildTargets &&
      version &&
      after &&
      sameSnapshotVersion(version, after)
    ) {
      this.cache.set(view.webContents, {
        version: after,
        optionsKey,
        content: captured.content,
        refs: captured.refs,
      });
    } else {
      this.cache.delete(view.webContents);
    }
    const result = snapshotResult(captured.content, captured.refs, options);
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
    const refs: SnapshotRef[] = [];
    const rootContent = formatAxTree(result.nodes ?? [], refs, options);
    const usedRefIds = new Set(
      refs.map((ref) => ref.refId ?? ref.backendNodeId),
    );
    let nextSyntheticRef = 1_000_000_000;
    const childSections: string[] = [];

    const childTargets = await scopedChildTargets(view.webContents);
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
        const childContent = formatAxTree(childResult.nodes ?? [], childRefs, {
          ...options,
          includeStableLocator: false,
          frameId: target.targetId,
          refIdForBackendNodeId: (backendNodeId) => {
            if (!usedRefIds.has(backendNodeId)) {
              usedRefIds.add(backendNodeId);
              return backendNodeId;
            }
            while (usedRefIds.has(nextSyntheticRef)) nextSyntheticRef += 1;
            const refId = nextSyntheticRef++;
            usedRefIds.add(refId);
            return refId;
          },
        });
        refs.push(...childRefs);
        if (childContent) {
          const label = target.title || target.url || target.targetId;
          childSections.push(
            `iframe ${JSON.stringify(label)}\n${indent(childContent, 1)}`,
          );
        }
      } catch {
        // A child frame may navigate or disappear while its AX tree is read.
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
    while (history.size > 4096) {
      const oldest = history.keys().next().value;
      if (oldest === undefined) break;
      history.delete(oldest);
    }
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
  return `${options.includeActionMarks !== false ? 1 : 0}:${
    options.includeStableLocator !== false ? 1 : 0
  }`;
}

function snapshotResult(
  content: string,
  refs: SnapshotRef[],
  options: SnapshotOptions,
) {
  return {
    content:
      typeof options.maxResultLength === "number"
        ? content.slice(0, options.maxResultLength)
        : content,
    refs,
  };
}

export function formatAxTree(
  nodes: AxNode[],
  refs: SnapshotRef[],
  options: {
    includeActionMarks?: boolean;
    includeStableLocator?: boolean;
    frameId?: string;
    refIdForBackendNodeId?: (backendNodeId: number) => number;
  } = {},
) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const roots = nodes.filter((node) => !childIds.has(node.nodeId));
  const locatorCounts = countStableLocators(roots, byId);
  const lines: string[] = [];
  const visit = (node: AxNode, depth: number, insideFrame = false) => {
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
    const candidate =
      actionable && !insideFrame && options.includeStableLocator !== false
        ? stableLocator(role, name, node)
        : undefined;
    const locator =
      candidate && locatorCounts.get(candidate) === 1 ? candidate : undefined;
    let suffix = "";
    if (actionable && options.includeActionMarks !== false) {
      const refId = options.refIdForBackendNodeId
        ? options.refIdForBackendNodeId(node.backendDOMNodeId!)
        : node.backendDOMNodeId!;
      suffix += ` [ref=${refId}`;
      if (locator) suffix += `, loc=${locator}`;
      suffix += "]";
      refs.push({
        refId,
        backendNodeId: node.backendDOMNodeId!,
        role,
        name,
        loc: locator,
        frameId: options.frameId,
      });
    }
    const label = name ? `${role} ${JSON.stringify(name)}` : role;
    if (label !== "generic" && label !== "none") {
      lines.push(`${"  ".repeat(depth)}${label}${suffix}`);
      depth += 1;
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) {
        visit(child, depth, insideFrame || role.toLowerCase() === "iframe");
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
      ACTION_ROLES.has(role.toLowerCase()) &&
      typeof node.backendDOMNodeId === "number"
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
  if (role === "link" && typeof url === "string") return `href:${url}`;
  if (name) return `role:${role}[name=${JSON.stringify(name)}]`;
  return undefined;
}
