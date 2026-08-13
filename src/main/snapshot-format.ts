type AxValue = { value?: unknown };
export type SnapshotAxNode = {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  properties?: Array<{ name: string; value?: AxValue }>;
  childIds?: string[];
};

export type SnapshotRef = {
  refId?: number;
  backendNodeId: number;
  role: string;
  name: string;
  loc?: string;
  frameId?: string;
  matchCount?: number;
  matchIndex?: number;
};

const ACTION_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio",
  "combobox", "menuitem", "tab", "switch", "slider", "iframe",
]);
const STRUCTURAL_LOCATOR_ROLES = new Set([
  "dialog", "alertdialog", "region", "main", "form",
]);

export function formatAxTree(
  nodes: SnapshotAxNode[],
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
  const locatorOccurrences = new Map<string, number>();
  const lines: string[] = [];
  const visit = (node: SnapshotAxNode, depth: number, insideFrame = false) => {
    if (node.ignored) {
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) visit(child, depth, insideFrame);
      }
      return;
    }
    const role = String(node.role?.value || "container");
    const name = String(node.name?.value || "").trim();
    const actionable = ACTION_ROLES.has(role.toLowerCase()) && typeof node.backendDOMNodeId === "number";
    const locatorEligible = !insideFrame && options.includeStableLocator !== false && (actionable || STRUCTURAL_LOCATOR_ROLES.has(role.toLowerCase()));
    const candidate = locatorEligible ? stableLocator(role, name, node) : undefined;
    const matchCount = candidate ? locatorCounts.get(candidate) ?? 0 : 0;
    const matchIndex = candidate
      ? (locatorOccurrences.set(candidate, (locatorOccurrences.get(candidate) ?? 0) + 1), (locatorOccurrences.get(candidate) ?? 1) - 1)
      : undefined;
    const locator = candidate && matchCount === 1 ? candidate : undefined;
    let suffix = "";
    if (actionable && options.includeActionMarks !== false) {
      const refId = options.refIdForBackendNodeId ? options.refIdForBackendNodeId(node.backendDOMNodeId!) : node.backendDOMNodeId!;
      suffix += ` [ref=${refId}`;
      if (locator) suffix += `, loc=${locator}`;
      else if (candidate && matchCount > 1) suffix += `, loc=ambiguous, hint=use nth(${matchIndex}) of ${matchCount}`;
      suffix += "]";
      refs.push({ refId, backendNodeId: node.backendDOMNodeId!, role, name, loc: locator, frameId: options.frameId, matchCount: matchCount || undefined, matchIndex });
    }
    if (!actionable && candidate) {
      if (locator) suffix = ` [loc=${locator}]`;
      else if (matchCount > 1) suffix = ` [loc=ambiguous, hint=use a narrower ${role} locator]`;
    }
    const label = name ? `${role} ${JSON.stringify(name)}` : role;
    if (label !== "generic" && label !== "none") {
      lines.push(`${"  ".repeat(depth)}${label}${suffix}`);
      depth += 1;
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, depth, insideFrame || role.toLowerCase() === "iframe");
    }
  };
  for (const root of roots) visit(root, 0);
  return lines.join("\n");
}

function countStableLocators(roots: SnapshotAxNode[], byId: Map<string, SnapshotAxNode>) {
  const counts = new Map<string, number>();
  const visit = (node: SnapshotAxNode, insideFrame = false) => {
    const role = String(node.role?.value || "container");
    const name = String(node.name?.value || "").trim();
    if (!node.ignored && !insideFrame && (ACTION_ROLES.has(role.toLowerCase()) || STRUCTURAL_LOCATOR_ROLES.has(role.toLowerCase()))) {
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

function stableLocator(role: string, name: string, node: SnapshotAxNode) {
  const url = node.properties?.find((property) => property.name === "url")?.value?.value;
  if (role === "link" && typeof url === "string") return `href:${url}`;
  if (name) return `role:${role}[name=${JSON.stringify(name)}]`;
  if (STRUCTURAL_LOCATOR_ROLES.has(role.toLowerCase())) return `role:${role}`;
  return undefined;
}

