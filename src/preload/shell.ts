import { contextBridge, ipcRenderer } from "electron";

function on(channel: string, listener: (payload: any) => void) {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: any) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

contextBridge.exposeInMainWorld("xBrowser", {
  app: {
    info: () => ipcRenderer.invoke("x-browser:app:info"),
  },
  overview: {
    list: () => ipcRenderer.invoke("x-browser:overview:list"),
    create: (name?: string, profileId?: string) =>
      ipcRenderer.invoke("x-browser:overview:create", name, profileId),
    prepare: (spaceId: number) =>
      ipcRenderer.invoke("x-browser:overview:prepare", spaceId),
    transitionSnapshot: (
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("x-browser:overview:transition-snapshot", rect),
    open: (spaceId: number) =>
      ipcRenderer.invoke("x-browser:overview:open", spaceId),
    rename: (spaceId: number, name: string) =>
      ipcRenderer.invoke("x-browser:overview:rename", spaceId, name),
    close: (spaceId: number) =>
      ipcRenderer.invoke("x-browser:overview:close", spaceId),
    setVisible: (
      cards: Array<{ id: number; rect: { x: number; y: number; width: number; height: number } }>,
      viewport: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("x-browser:overview:visible", cards, viewport),
    onChanged: (listener: (spaces: any[]) => void) =>
      on("x-browser:spaces-changed", listener),
    onPreviewFrame: (listener: (frame: any) => void) =>
      on("x-browser:overview-preview-frame", listener),
  },
  profiles: {
    list: () => ipcRenderer.invoke("x-browser:profiles:list"),
    setDefault: (profileId: string) =>
      ipcRenderer.invoke("x-browser:profiles:set-default", profileId),
    remove: (profileId: string) =>
      ipcRenderer.invoke("x-browser:profiles:remove", profileId),
    setSync: (profileId: string, enabled: boolean) =>
      ipcRenderer.invoke("x-browser:profiles:sync-set", profileId, enabled),
    syncNow: (profileId: string) =>
      ipcRenderer.invoke("x-browser:profiles:sync-now", profileId),
    cloneUfo: (
      sourceProfileId: string,
      name: string,
      makeDefault: boolean,
      loginSyncEnabled: boolean,
    ) =>
      ipcRenderer.invoke(
        "x-browser:profiles:clone-ufo",
        sourceProfileId,
        name,
        makeDefault,
        loginSyncEnabled,
      ),
    discoverChrome: () =>
      ipcRenderer.invoke("x-browser:profiles:chrome-discover"),
    quitChrome: () => ipcRenderer.invoke("x-browser:profiles:chrome-quit"),
    importChrome: (
      profileDirName: string,
      makeDefault: boolean,
      allowPartial: boolean,
    ) =>
      ipcRenderer.invoke(
        "x-browser:profiles:chrome-import",
        profileDirName,
        makeDefault,
        allowPartial,
      ),
    onImportProgress: (listener: (progress: any) => void) =>
      on("x-browser:chrome-import-progress", listener),
    onSyncProgress: (listener: (progress: any) => void) =>
      on("x-browser:profile-sync-progress", listener),
  },
  browser: {
    state: () => ipcRenderer.invoke("x-browser:browser:state"),
    showOverview: () => ipcRenderer.invoke("x-browser:browser:overview"),
    createTab: (url?: string) =>
      ipcRenderer.invoke("x-browser:browser:create-tab", url),
    activateTab: (targetId: string) =>
      ipcRenderer.invoke("x-browser:browser:activate-tab", targetId),
    reorderTab: (targetId: string, beforeTargetId: string | null) =>
      ipcRenderer.invoke(
        "x-browser:browser:reorder-tab",
        targetId,
        beforeTargetId,
      ),
    closeTab: (targetId: string) =>
      ipcRenderer.invoke("x-browser:browser:close-tab", targetId),
    navigate: (input: string) =>
      ipcRenderer.invoke("x-browser:browser:navigate", input),
    back: () => ipcRenderer.invoke("x-browser:browser:back"),
    forward: () => ipcRenderer.invoke("x-browser:browser:forward"),
    reload: () => ipcRenderer.invoke("x-browser:browser:reload"),
    onChanged: (listener: (state: any) => void) =>
      on("x-browser:browser-state", listener),
    onFocusAddress: (listener: (targetId: string) => void) =>
      on("x-browser:browser-focus-address", listener),
  },
  control: {
    takeOver: (spaceId: number) =>
      ipcRenderer.invoke("x-browser:control:take-over", spaceId),
    complete: (spaceId: number) =>
      ipcRenderer.invoke("x-browser:control:complete", spaceId),
  },
  overlay: {
    onState: (listener: (state: any) => void) =>
      on("x-browser:agent-overlay-state", listener),
    onPointer: (listener: (state: any) => void) =>
      on("x-browser:agent-overlay-pointer", listener),
  },
  chat: {
    send: (text: string) => ipcRenderer.invoke("x-browser:chat:send", text),
    stop: () => ipcRenderer.invoke("x-browser:chat:stop"),
    onEvent: (listener: (event: any) => void) =>
      on("x-browser:chat-event", listener),
  },
  onPresentation: (listener: (state: any) => void) =>
    on("x-browser:presentation", listener),
});
