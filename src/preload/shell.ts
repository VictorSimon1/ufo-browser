import { contextBridge, ipcRenderer } from "electron";

function on(channel: string, listener: (payload: any) => void) {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: any) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

contextBridge.exposeInMainWorld("xBrowser", {
  overview: {
    list: () => ipcRenderer.invoke("x-browser:overview:list"),
    create: (name?: string) =>
      ipcRenderer.invoke("x-browser:overview:create", name),
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
