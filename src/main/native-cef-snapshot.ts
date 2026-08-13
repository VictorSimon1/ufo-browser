import { formatAxTree } from "./snapshot-format.js";
import type { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";

export class NativeCefSnapshotService {
  private readonly refs = new Map<number, any[]>();
  constructor(private readonly manager: NativeCefTaskSpaceManager) {}

  async snapshot(spaceId: number, options: any = {}) {
    const runtime = await this.manager.ensureRuntime(spaceId);
    const target = (await runtime.targets()).find((candidate) => candidate.type === "page");
    if (!target?.webSocketDebuggerUrl) throw new Error("native page target is unavailable");
    const connection = await runtime.connect(target.id);
    try {
      await connection.send("Accessibility.enable");
      const result = await connection.send("Accessibility.getFullAXTree");
      const snapshotRefs: any[] = [];
      const content = formatAxTree(result.nodes || [], snapshotRefs, options);
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
    const candidates = current.refs.filter((candidate: any) => previous.loc && candidate.loc === previous.loc || candidate.role === previous.role && candidate.name === previous.name);
    if (candidates.length > 1) throw new Error(`EGO_STALE_REF_AMBIGUOUS: stale ref @${refId} matched ${candidates.length} elements after refresh`);
    return candidates[0] ? { ...candidates[0], refId } : null;
  }
}
