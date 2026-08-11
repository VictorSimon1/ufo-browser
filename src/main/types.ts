export type SpaceOwnership = "agent" | "agentDelegatedToUser" | "user";
export type SpaceLifecycle = "active" | "completed" | "error";
export type SpaceProfileMode = "persistent" | "temporary";

export type AgentTaskState = {
  title: string;
  detail: string;
  completed: number;
  total: number;
  updatedAt: number;
};

export type TabRecord = {
  targetId: string;
  url: string;
  title: string;
  createdAt: number;
};

export type SpaceRecord = {
  id: number;
  taskId: string;
  name: string;
  createdBy: "agent" | "user";
  ownership: SpaceOwnership;
  lifecycle: SpaceLifecycle;
  profileId: string;
  profileMode: SpaceProfileMode;
  sessionScopeId?: string;
  tabs: TabRecord[];
  activeTabId: string;
  agentTask?: AgentTaskState;
  createdAt: number;
  updatedAt: number;
};

export type BrowserState = {
  version: 1;
  nextSpaceId: number;
  spaces: SpaceRecord[];
};

export type Presentation =
  | { kind: "overview" }
  | { kind: "space"; spaceId: number };

export type PublicSpace = Omit<SpaceRecord, "tabs"> & {
  tabs: TabRecord[];
  recentTabTitles: string[];
};

export type Rect = { x: number; y: number; width: number; height: number };
