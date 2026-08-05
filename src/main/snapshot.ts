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

export class SnapshotService {
  constructor(private readonly manager: TaskSpaceManager) {}

  async snapshot(
    spaceId: number,
    options: {
      includeActionMarks?: boolean;
      includeStableLocator?: boolean;
      maxResultLength?: number;
    } = {},
  ) {
    const tab = this.manager.getActiveTab(spaceId);
    const view = await this.manager.ensureTabRuntime(spaceId, tab.targetId);
    if (!view.webContents.debugger.isAttached()) {
      view.webContents.debugger.attach("1.3");
    }
    await view.webContents.debugger.sendCommand("Accessibility.enable");
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

    for (const target of await scopedChildTargets(view.webContents)) {
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
      content:
        typeof options.maxResultLength === "number"
          ? content.slice(0, options.maxResultLength)
          : content,
      refs,
    };
  }
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
  const lines: string[] = [];
  const visit = (node: AxNode, depth: number) => {
    if (node.ignored) {
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) visit(child, depth);
      }
      return;
    }
    const role = String(node.role?.value || "container");
    const name = String(node.name?.value || "").trim();
    const actionable =
      ACTION_ROLES.has(role.toLowerCase()) &&
      typeof node.backendDOMNodeId === "number";
    const locator =
      actionable && options.includeStableLocator !== false
        ? stableLocator(role, name, node)
        : undefined;
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
      if (child) visit(child, depth);
    }
  };
  for (const root of roots) visit(root, 0);
  return lines.join("\n");
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
  return "unstable";
}
