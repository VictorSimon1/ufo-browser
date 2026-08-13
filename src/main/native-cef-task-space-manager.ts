import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BrowserProfileRegistry } from "./profile-registry.js";
import { BrowserStateStore } from "./state-store.js";
import type { SpaceLifecycle, SpaceOwnership, SpaceRecord, TabRecord } from "./types.js";
import {
  isTemporaryProfileId,
  isTemporarySpace,
  TEMPORARY_PROFILE_ID,
} from "./temporary-profile.js";
import { NativeCefRuntime, type NativeCefRuntimeOptions } from "./native-cef-runtime.js";

export type NativeCefTaskSpaceManagerOptions = {
  store: BrowserStateStore;
  profiles: BrowserProfileRegistry;
  partitionsRoot: string;
  executable?: string;
  portBase?: number;
};

/**
 * Electron-free Task Space manager used by the native CEF Agent Host.
 *
 * A Space owns a CEF Chrome Runtime process and a persistent user-data
 * directory. The first native slice intentionally uses one browser target per
 * Space; CEF's own toolbar remains responsible for human tab UI while the
 * Agent protocol is layered on the active target.
 */
export class NativeCefTaskSpaceManager {
  private state = { version: 1 as const, nextSpaceId: 1, spaces: [] as SpaceRecord[] };
  private readonly runtimes = new Map<number, NativeCefRuntime>();

  constructor(private readonly options: NativeCefTaskSpaceManagerOptions) {}

  async initialize() {
    const loaded = await this.options.store.load();
    this.state = loaded;
  }

  async flushState() {
    await this.options.store.flush();
  }

  listSpaces() {
    return this.state.spaces.map((space) => ({
      ...structuredClone(space),
      recentTabTitles: space.tabs.map((tab) => tab.title).filter(Boolean).slice(-3),
    }));
  }

  listProfiles() {
    return this.options.profiles.listPublic().map((profile) => ({
      id: profile.id === "default" ? "Default" : profile.id,
      isDefault: profile.isDefault,
      name: profile.name,
    }));
  }

  getSpace(spaceId: number) {
    return this.state.spaces.find((space) => space.id === spaceId);
  }

  getSpaceOrThrow(spaceId: number) {
    const space = this.getSpace(spaceId);
    if (!space) throw new Error(`task space not found: ${spaceId}`);
    return space;
  }

  async createSpace(name: string, createdBy: "agent" | "user" = "user", profileId?: string) {
    const temporary = isTemporaryProfileId(profileId);
    const profile = temporary ? undefined : profileId ? this.options.profiles.getOrThrow(profileId) : this.options.profiles.getDefault();
    const now = Date.now();
    const trimmed = name.trim() || `Space ${this.state.nextSpaceId}`;
    const tab = this.newTab("https://www.google.com/");
    const space: SpaceRecord = {
      id: this.state.nextSpaceId++,
      taskId: trimmed,
      name: trimmed,
      createdBy,
      ownership: createdBy === "agent" ? "agent" : "user",
      lifecycle: "active",
      profileId: temporary ? TEMPORARY_PROFILE_ID : profile!.id,
      profileMode: temporary ? "temporary" : "persistent",
      sessionScopeId: temporary ? `native-temporary-${randomUUID()}` : undefined,
      tabs: [tab],
      activeTabId: tab.targetId,
      agentTask: createdBy === "agent" ? {
        title: trimmed,
        detail: "Agent is preparing the native browser",
        completed: 0,
        total: 1,
        updatedAt: now,
      } : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.state.spaces.push(space);
    await this.save();
    return structuredClone(space);
  }

  async renameSpace(spaceId: number, name: string) {
    const space = this.getSpaceOrThrow(spaceId);
    space.name = name.trim() || space.name;
    space.taskId = space.name;
    space.updatedAt = Date.now();
    await this.save();
    return structuredClone(space);
  }

  async setOwnership(spaceId: number, ownership: SpaceOwnership, lifecycle: SpaceLifecycle = "active") {
    const space = this.getSpaceOrThrow(spaceId);
    space.ownership = ownership;
    space.lifecycle = lifecycle;
    space.updatedAt = Date.now();
    await this.save();
    return structuredClone(space);
  }

  async setLifecycle(spaceId: number, lifecycle: SpaceLifecycle) {
    const space = this.getSpaceOrThrow(spaceId);
    space.lifecycle = lifecycle;
    space.updatedAt = Date.now();
    await this.save();
    return structuredClone(space);
  }

  async setAgentTaskState(spaceId: number, state: any) {
    const space = this.getSpaceOrThrow(spaceId);
    space.agentTask = {
      title: String(state?.title ?? space.agentTask?.title ?? space.name),
      detail: String(state?.detail ?? ""),
      completed: Number(state?.completed ?? 0),
      total: Number(state?.total ?? 1),
      updatedAt: Date.now(),
    };
    await this.save();
  }

  async createAgentTab(spaceId: number, url = "https://www.google.com/") {
    const space = this.getSpaceOrThrow(spaceId);
    const tab = space.tabs[0];
    if (space.tabs.length !== 1 || tab.url !== "https://www.google.com/" || this.runtimes.has(spaceId)) {
      return this.createTab(spaceId, url);
    }
    tab.url = url;
    tab.title = "New Tab";
    space.updatedAt = Date.now();
    await this.save();
    await this.ensureRuntime(spaceId, url);
    return structuredClone(space.tabs[0]);
  }

  async createTab(spaceId: number, url = "https://www.google.com/") {
    const space = this.getSpaceOrThrow(spaceId);
    if (this.runtimes.has(spaceId)) {
      throw new Error("Native CEF vertical slice currently supports one Agent target per Space");
    }
    const tab = this.newTab(url);
    space.tabs.push(tab);
    space.activeTabId = tab.targetId;
    space.updatedAt = Date.now();
    await this.save();
    await this.ensureRuntime(spaceId, url);
    return structuredClone(space.tabs.at(-1));
  }

  async closeSpace(spaceId: number) {
    const index = this.state.spaces.findIndex((space) => space.id === spaceId);
    if (index < 0) return false;
    const runtime = this.runtimes.get(spaceId);
    this.runtimes.delete(spaceId);
    await runtime?.stop().catch(() => undefined);
    this.state.spaces.splice(index, 1);
    await this.save();
    return true;
  }

  async ensureRuntime(spaceId: number, url?: string) {
    const existing = this.runtimes.get(spaceId);
    if (existing?.isRunning()) return existing;
    const space = this.getSpaceOrThrow(spaceId);
    const tab = space.tabs.find((candidate) => candidate.targetId === space.activeTabId) ?? space.tabs[0];
    if (!tab) throw new Error("native Space has no active tab");
    const dataDir = join(this.options.partitionsRoot, `space-${spaceId}`);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const runtimeOptions: NativeCefRuntimeOptions = {
      executable: this.options.executable,
      url: url || tab.url,
      port: (this.options.portBase ?? 9420) + spaceId,
      userDataDir: dataDir,
    };
    const runtime = new NativeCefRuntime(runtimeOptions);
    await runtime.start();
    const target = await waitForPageTarget(runtime, tab.url, 15_000);
    if (!target) {
      await runtime.stop();
      throw new Error("Native CEF did not expose a page target");
    }
    await waitForRendererNavigation(runtime, target.id, tab.url, 15_000);
    const previousTargetId = tab.targetId;
    tab.targetId = target.id;
    if (space.activeTabId === previousTargetId) space.activeTabId = target.id;
    tab.url = target.url || tab.url;
    tab.title = target.title || tab.title;
    this.runtimes.set(spaceId, runtime);
    await this.save();
    return runtime;
  }

  getRuntime(spaceId: number) {
    return this.runtimes.get(spaceId);
  }

  getActiveTab(spaceId: number) {
    const space = this.getSpaceOrThrow(spaceId);
    return space.tabs.find((tab) => tab.targetId === space.activeTabId) ?? space.tabs[0];
  }

  async ensureTabRuntime(spaceId: number, targetId: string) {
    const runtime = await this.ensureRuntime(spaceId);
    const tab = this.getSpaceOrThrow(spaceId).tabs.find((candidate) => candidate.targetId === targetId);
    if (!tab) throw new Error(`tab not found: ${targetId}`);
    return runtime;
  }

  setAgentConnectionActive(_spaceId: number, _active: boolean) {}
  showAgentPointer(_spaceId: number, _x: number, _y: number) {}

  async shutdown() {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(runtimes.map((runtime) => runtime.stop().catch(() => undefined)));
  }

  private newTab(url: string): TabRecord {
    return { targetId: `native-tab-${randomUUID()}`, url, title: "", createdAt: Date.now() };
  }

  private save() {
    return this.options.store.save(this.state);
  }
}

async function waitForPageTarget(runtime: NativeCefRuntime, expectedUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastTarget: any;
  while (Date.now() < deadline) {
    const target = (await runtime.targets()).find((candidate) => candidate.type === "page");
    lastTarget = target;
    if (target?.webSocketDebuggerUrl && target.url && target.url !== "about:blank") {
      if (!expectedUrl || target.url === expectedUrl || target.url.startsWith(expectedUrl)) return target;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (lastTarget?.webSocketDebuggerUrl) return lastTarget;
  throw new Error("Native CEF page target did not become ready");
}

async function waitForRendererNavigation(runtime: NativeCefRuntime, targetId: string, expectedUrl: string, timeoutMs: number) {
  const connection = await runtime.connect(targetId);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const result = await connection.send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      }).catch(() => undefined);
      const url = result?.result?.value;
      if (typeof url === "string" && url !== "about:blank" && (!expectedUrl || url === expectedUrl || url.startsWith(expectedUrl))) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  } finally {
    await connection.close();
  }
}
