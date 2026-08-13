import { formatAxTree } from "./snapshot-format.js";
import type { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";

export class NativeCefSnapshotService {
  private readonly refs = new Map<number, any[]>();
  constructor(private readonly manager: NativeCefTaskSpaceManager) {}

  async snapshot(spaceId: number, options: any = {}) {
    const runtime = await this.manager.ensureRuntime(spaceId);
    const active = this.manager.getActiveTab(spaceId);
    const targets = await runtime.targets();
    const target = targets.find((candidate) => candidate.id === active?.targetId) ??
      targets.find((candidate) => candidate.type === "page");
    if (!target || (!target.webSocketDebuggerUrl && !runtime.usesPrivateBridge())) throw new Error("native page target is unavailable");
    const connection = await runtime.connect(target.id);
    try {
      await connection.send("Accessibility.enable");
      const result = await connection.send("Accessibility.getFullAXTree");
      const snapshotRefs: any[] = [];
      const usedRefIds = new Set<number>(
        (result.nodes || [])
          .map((node: any) => Number(node.backendDOMNodeId))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      );
      let nextSyntheticRef = 1_000_000_000;
      const contentSections = [formatAxTree(result.nodes || [], snapshotRefs, options)];
      // Chromium exposes out-of-process/cross-origin frames as independent
      // iframe targets. Keep the Agent snapshot contract identical to the
      // Electron path by appending each child AX tree and tagging refs with
      // the child target id so the existing session resolver can attach to it.
      const childTargets = (await runtime.targets()).filter((candidate: any) =>
        candidate.type === "iframe" &&
        (candidate.parentId === target.id || candidate.parentFrameId === target.id),
      );
      for (const child of childTargets) {
        let childConnection: any;
        try {
          childConnection = await runtime.connectRaw(child.id);
          await childConnection.send("Accessibility.enable");
          const childResult = await childConnection.send("Accessibility.getFullAXTree");
          const childRefs: any[] = [];
          const childContent = formatAxTree(childResult.nodes || [], childRefs, {
            ...options,
            includeStableLocator: false,
            frameId: child.id,
            refIdForBackendNodeId: (backendNodeId: number) => {
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
          snapshotRefs.push(...childRefs);
          if (childContent) {
            contentSections.push(`iframe ${JSON.stringify(child.title || child.url || child.id)}\n${indent(childContent, 1)}`);
          }
        } catch {
          // A child target can navigate or disappear while its AX tree is read.
        } finally {
          await childConnection?.close().catch(() => undefined);
        }
      }
      const content = contentSections.filter(Boolean).join("\n");
      this.refs.set(spaceId, snapshotRefs);
      return { content: typeof options.maxResultLength === "number" ? content.slice(0, options.maxResultLength) : content, refs: snapshotRefs };
    } finally {
      await connection.close();
    }
  }

  async resolveHistoricalRef(spaceId: number, refId: number) {
    const previous = this.refs.get(spaceId)?.find((ref) => ref.refId === refId);
    if (!previous) return null;
    const current = await this.snapshot(spaceId, { includeActionMarks: true, includeStableLocator: true });
    const candidates = current.refs.filter((candidate: any) =>
      candidate.frameId === previous.frameId &&
      ((previous.loc && candidate.loc === previous.loc) ||
        (candidate.role === previous.role && candidate.name === previous.name)),
    );
    if (candidates.length > 1) throw new Error(`EGO_STALE_REF_AMBIGUOUS: stale ref @${refId} matched ${candidates.length} elements after refresh`);
    return candidates[0] ? { ...candidates[0], refId } : null;
  }
}

function indent(value: string, level: number) {
  const prefix = "  ".repeat(level);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}
