import { session, WebContentsView } from "electron";
import {
  configureChromiumSession,
  ensureChromiumProfilePreferences,
} from "../chromium-identity.js";
import type { CookieWriteTarget } from "./cookie-writer.js";

export async function createElectronCookieWriteTarget(options: {
  partitionsRoot: string;
  profileId: string;
  partitionId: string;
}): Promise<CookieWriteTarget> {
  await ensureChromiumProfilePreferences(
    options.partitionsRoot,
    options.profileId,
    options.partitionId,
  );
  const partition = `persist:${options.partitionId}`;
  const chromiumSession = session.fromPartition(partition);
  await configureChromiumSession(chromiumSession);
  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
  await view.webContents.loadURL("about:blank");
  view.webContents.debugger.attach("1.3");
  let disposed = false;
  return {
    cookies: chromiumSession.cookies,
    cdp: {
      send: (method, params) =>
        view.webContents.debugger.sendCommand(method, params),
    },
    flush: () => chromiumSession.flushStorageData(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (view.webContents.debugger.isAttached()) {
        view.webContents.debugger.detach();
      }
      view.webContents.close();
    },
  };
}
