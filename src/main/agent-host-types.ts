/** Minimal host contracts shared by the Electron fallback and native CEF host. */
export type AgentManagerHost = {
  listSpaces(): any[];
  listProfiles(): any[];
  createSpace(name: string, createdBy?: "agent" | "user", profileId?: string): Promise<any>;
  getSpace(spaceId: number): any;
  getSpaceOrThrow(spaceId: number): any;
  setOwnership(spaceId: number, ownership: any, lifecycle?: any): Promise<any>;
  renameSpace(spaceId: number, name: string): Promise<any>;
  createAgentTab(spaceId: number, url?: string): Promise<any>;
  createTab(spaceId: number, url?: string): Promise<any>;
  closeSpace(spaceId: number): Promise<any>;
  setLifecycle(spaceId: number, lifecycle: any): Promise<any>;
  setAgentTaskState(spaceId: number, state: any): Promise<any>;
  showAgentPointer?(spaceId: number, x: number, y: number): void;
  setAgentConnectionActive?(spaceId: number, active: boolean): void;
};

export type AgentSnapshotHost = {
  snapshot(spaceId: number, options?: any): Promise<any>;
  resolveHistoricalRef(spaceId: number, refId: number): Promise<any>;
};

export type AgentCdpBrokerHost = {
  registerConnection(connectionId: string, sender: (payload: string) => void): void;
  removeConnection(connectionId: string): void;
  releaseConnectionSpace(connectionId: string, spaceId: number): void;
  send(connectionId: string, spaceId: number, generation: number, payload: string): Promise<void>;
};

