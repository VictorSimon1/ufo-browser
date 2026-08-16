import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BaseWindow, WebContentsView } from "electron";
import type { Rect } from "./types.js";

type NativeTransitionAddon = {
  cacheSnapshot(
    key: string,
    chromePng: Buffer,
    pagePng: Buffer,
    logicalWidth: number,
  ): boolean;
  hasSnapshot(key: string): boolean;
  beginTransition(
    nativeWindowHandle: Buffer,
    key: string,
    options: Rect & { token: string; direction?: "enter" | "exit" },
  ): { started: boolean; durationMs?: number };
  beginNavigationHandoff(
    nativeWindowHandle: Buffer,
    pagePng: Buffer,
    options: Rect & { token: string },
  ): boolean;
  finishNavigationHandoff(token: string): boolean;
  navigationHandoffVisible(): boolean;
  finishTransition(token: string): boolean;
  cancelTransition(token: string): boolean;
};

export type NativeSpaceTransitionRun = {
  token: string;
  durationMs: number;
  startedAt: number;
};

type SnapshotMeta = {
  version: 2;
  logicalWidth: number;
  capturedAt: number;
};

const SNAPSHOT_VERSION = 2;
const MAX_PRIMED_SNAPSHOTS = 6;
const CAPTURE_SCALE_FACTOR = 2;

export class NativeSpaceTransition {
  private readonly addon?: NativeTransitionAddon;
  private readonly runs = new Map<string, NativeSpaceTransitionRun>();
  private captureQueue = Promise.resolve();

  constructor(
    private readonly window: BaseWindow,
    private readonly snapshotRoot: string,
    addonPath: string,
  ) {
    if (process.platform !== "darwin") return;
    try {
      const require = createRequire(import.meta.url);
      this.addon = require(addonPath) as NativeTransitionAddon;
    } catch (error) {
      console.warn("Native Space transition is unavailable", error);
    }
  }

  async prime(spaceIds: number[]) {
    if (!this.addon) return;
    await Promise.all(
      spaceIds.slice(0, MAX_PRIMED_SNAPSHOTS).map((spaceId) =>
        this.loadSnapshot(spaceId).catch(() => false),
      ),
    );
  }

  hasSnapshot(spaceId: number) {
    return Boolean(this.addon?.hasSnapshot(this.key(spaceId)));
  }

  begin(spaceId: number, token: string, source: Rect) {
    return this.beginDirection(spaceId, token, source, "enter");
  }

  beginExit(spaceId: number, token: string, destination: Rect) {
    return this.beginDirection(spaceId, token, destination, "exit");
  }

  private beginDirection(
    spaceId: number,
    token: string,
    target: Rect,
    direction: "enter" | "exit",
  ) {
    if (!this.addon || !token || !this.hasSnapshot(spaceId)) return undefined;
    try {
      const result = this.addon.beginTransition(
        this.window.getNativeWindowHandle(),
        this.key(spaceId),
        { ...target, token, direction },
      );
      if (!result?.started) return undefined;
      const run: NativeSpaceTransitionRun = {
        token,
        durationMs: Math.max(1, Math.round(result.durationMs || 320)),
        startedAt: performance.now(),
      };
      this.runs.set(token, run);
      return run;
    } catch (error) {
      console.warn("Unable to begin native Space transition", error);
      return undefined;
    }
  }

  remainingMs(token: string) {
    const run = this.runs.get(token);
    if (!run) return 0;
    return Math.max(0, run.durationMs - (performance.now() - run.startedAt));
  }

  finish(token: string) {
    const run = this.runs.get(token);
    this.runs.delete(token);
    if (!run || !this.addon) return false;
    try {
      return this.addon.finishTransition(token);
    } catch {
      return false;
    }
  }

  cancel(token: string) {
    const run = this.runs.get(token);
    this.runs.delete(token);
    if (!run || !this.addon) return false;
    try {
      return this.addon.cancelTransition(token);
    } catch {
      return false;
    }
  }

  async beginNavigationHandoff(
    token: string,
    pageView: WebContentsView,
    bounds: Rect,
  ) {
    if (
      !this.addon ||
      !token ||
      pageView.webContents.isDestroyed() ||
      bounds.width < 1 ||
      bounds.height < 1
    ) {
      return false;
    }
    try {
      const image = await pageView.webContents.capturePage({
        x: 0,
        y: 0,
        width: bounds.width,
        height: bounds.height,
      });
      if (image.isEmpty() || pageView.webContents.isDestroyed()) return false;
      return Boolean(
        this.addon.beginNavigationHandoff(
          this.window.getNativeWindowHandle(),
          image.toPNG(),
          { ...bounds, token },
        ),
      );
    } catch {
      return false;
    }
  }

  finishNavigationHandoff(token: string) {
    if (!this.addon || !token) return false;
    try {
      return this.addon.finishNavigationHandoff(token);
    } catch {
      return false;
    }
  }

  navigationHandoffVisible() {
    try {
      return Boolean(this.addon?.navigationHandoffVisible());
    } catch {
      return false;
    }
  }

  capture(
    spaceId: number,
    browserView: WebContentsView,
    pageView: WebContentsView,
    contentSize: { width: number; height: number; chromeHeight: number },
    nativeChromePng?: Buffer,
  ) {
    if (!this.addon) return Promise.resolve(false);
    const task = this.captureQueue.then(() =>
      this.captureNow(
        spaceId,
        browserView,
        pageView,
        contentSize,
        nativeChromePng,
      ),
    );
    this.captureQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async captureNow(
    spaceId: number,
    browserView: WebContentsView,
    pageView: WebContentsView,
    contentSize: { width: number; height: number; chromeHeight: number },
    nativeChromePng?: Buffer,
  ) {
    if (
      !this.addon ||
      browserView.webContents.isDestroyed() ||
      pageView.webContents.isDestroyed()
    ) {
      return false;
    }
    const visiblePageHeight = Math.max(
      1,
      contentSize.height - contentSize.chromeHeight,
    );
    const [chromeImage, pageImage] = await Promise.all([
      nativeChromePng
        ? Promise.resolve(undefined)
        : browserView.webContents.capturePage({
            x: 0,
            y: 0,
            width: contentSize.width,
            height: contentSize.chromeHeight,
          }),
      pageView.webContents.capturePage({
        x: 0,
        y: 0,
        width: contentSize.width,
        height: visiblePageHeight,
      }),
    ]);
    if ((!nativeChromePng && chromeImage?.isEmpty()) || pageImage.isEmpty()) {
      return false;
    }
    const chromePng =
      nativeChromePng ??
      chromeImage!.toPNG({ scaleFactor: CAPTURE_SCALE_FACTOR });
    const pagePng = pageImage.toPNG({ scaleFactor: CAPTURE_SCALE_FACTOR });
    if (chromePng.byteLength === 0 || pagePng.byteLength === 0) return false;
    const cached = this.addon.cacheSnapshot(
      this.key(spaceId),
      chromePng,
      pagePng,
      contentSize.width,
    );
    if (!cached) return false;
    void this.persistSnapshot(spaceId, chromePng, pagePng, {
      version: SNAPSHOT_VERSION,
      logicalWidth: contentSize.width,
      capturedAt: Date.now(),
    }).catch(() => undefined);
    return true;
  }

  private async loadSnapshot(spaceId: number) {
    if (!this.addon) return false;
    const directory = this.snapshotDirectory(spaceId);
    const [metaBuffer, chromePng, pagePng] = await Promise.all([
      readFile(join(directory, "meta.json")),
      readFile(join(directory, "chrome.png")),
      readFile(join(directory, "page.png")),
    ]);
    const meta = JSON.parse(metaBuffer.toString("utf8")) as SnapshotMeta;
    if (
      meta.version !== SNAPSHOT_VERSION ||
      !Number.isFinite(meta.logicalWidth) ||
      meta.logicalWidth < 1
    ) {
      return false;
    }
    return this.addon.cacheSnapshot(
      this.key(spaceId),
      chromePng,
      pagePng,
      meta.logicalWidth,
    );
  }

  private async persistSnapshot(
    spaceId: number,
    chromePng: Buffer,
    pagePng: Buffer,
    meta: SnapshotMeta,
  ) {
    const directory = this.snapshotDirectory(spaceId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(directory, "chrome.png"), chromePng, { mode: 0o600 }),
      writeFile(join(directory, "page.png"), pagePng, { mode: 0o600 }),
      writeFile(join(directory, "meta.json"), `${JSON.stringify(meta)}\n`, {
        mode: 0o600,
      }),
    ]);
  }

  private key(spaceId: number) {
    return `space:${spaceId}`;
  }

  private snapshotDirectory(spaceId: number) {
    return join(this.snapshotRoot, `space-${spaceId}`);
  }
}
