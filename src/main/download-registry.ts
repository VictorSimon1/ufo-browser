import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import type { DownloadItem, Event, Session, WebContents } from "electron";

type DownloadBehavior = "default" | "deny" | "allow" | "allowAndName";
type DownloadScope = "browser" | "page";

type DownloadRegistration = {
  connectionId: string;
  spaceId: number;
  targetId: string;
  scope: DownloadScope;
  behavior: DownloadBehavior;
  downloadPath?: string;
  configuredAt: number;
};

type DownloadSource = {
  spaceId: number;
  targetId: string;
};

type DownloadEvent = {
  connectionId: string;
  spaceId: number;
  targetId: string;
  method: "Page.downloadWillBegin" | "Page.downloadProgress";
  params: Record<string, unknown>;
};

type ConfigureDownload = {
  connectionId: string;
  spaceId: number;
  targetId: string;
  scope: DownloadScope;
  behavior?: unknown;
  downloadPath?: unknown;
  session: Session;
};

type DownloadRegistryOptions = {
  locateSource: (webContentsId: number) => DownloadSource | undefined;
  emit: (event: DownloadEvent) => void;
};

export class DownloadRegistry {
  private readonly registrations = new Map<string, DownloadRegistration>();
  private readonly boundSessions = new WeakSet<Session>();
  private readonly reservedPaths = new Set<string>();

  constructor(private readonly options: DownloadRegistryOptions) {}

  async configure(input: ConfigureDownload) {
    const behavior = normalizeBehavior(input.behavior);
    const key = registrationKey(
      input.connectionId,
      input.spaceId,
      input.scope,
      input.targetId,
    );
    if (behavior === "default") {
      this.registrations.delete(key);
      return;
    }

    let downloadPath: string | undefined;
    if (behavior === "allow" || behavior === "allowAndName") {
      downloadPath = await validateDownloadDirectory(input.downloadPath);
    }
    this.bindSession(input.session);
    this.registrations.set(key, {
      connectionId: input.connectionId,
      spaceId: input.spaceId,
      targetId: input.targetId,
      scope: input.scope,
      behavior,
      downloadPath,
      configuredAt: Date.now(),
    });
  }

  removeConnection(connectionId: string) {
    for (const [key, registration] of this.registrations) {
      if (registration.connectionId === connectionId) {
        this.registrations.delete(key);
      }
    }
  }

  releaseConnectionSpace(connectionId: string, spaceId: number) {
    for (const [key, registration] of this.registrations) {
      if (
        registration.connectionId === connectionId &&
        registration.spaceId === spaceId
      ) {
        this.registrations.delete(key);
      }
    }
  }

  private bindSession(chromiumSession: Session) {
    if (this.boundSessions.has(chromiumSession)) return;
    this.boundSessions.add(chromiumSession);
    chromiumSession.on("will-download", (event, item, webContents) => {
      this.handleDownload(event, item, webContents);
    });
  }

  private handleDownload(
    event: Event,
    item: DownloadItem,
    webContents: WebContents,
  ) {
    const source = this.options.locateSource(webContents.id);
    if (!source) return;
    const registration = this.registrationFor(source);
    if (!registration) return;

    const guid = randomUUID();
    const url = safeItemValue(() => item.getURL(), "");
    const originalFilename = safeFilename(
      safeItemValue(() => item.getFilename(), "download"),
    );
    const totalBytes = safeItemValue(() => item.getTotalBytes(), 0);

    if (registration.behavior === "deny") {
      event.preventDefault();
      this.emitWillBegin(registration, source, guid, url, originalFilename);
      this.emitProgress(
        registration,
        source,
        guid,
        "canceled",
        0,
        totalBytes,
      );
      return;
    }

    const directory = registration.downloadPath!;
    const savePath =
      registration.behavior === "allowAndName"
        ? join(directory, guid)
        : this.reserveUniquePath(directory, originalFilename);
    const reportedFilename =
      registration.behavior === "allowAndName"
        ? originalFilename
        : basename(savePath);
    item.setSavePath(savePath);
    this.emitWillBegin(registration, source, guid, url, reportedFilename);
    this.emitProgress(
      registration,
      source,
      guid,
      "inProgress",
      safeItemValue(() => item.getReceivedBytes(), 0),
      totalBytes,
    );

    let finished = false;
    item.on("updated", () => {
      if (finished) return;
      this.emitProgress(
        registration,
        source,
        guid,
        "inProgress",
        safeItemValue(() => item.getReceivedBytes(), 0),
        safeItemValue(() => item.getTotalBytes(), totalBytes),
      );
    });
    item.once("done", (_doneEvent, state) => {
      if (finished) return;
      finished = true;
      this.reservedPaths.delete(savePath);
      void this.finishDownload(
        registration,
        source,
        guid,
        savePath,
        state,
        item,
        totalBytes,
      );
    });
  }

  private registrationFor(source: DownloadSource) {
    const matches = [...this.registrations.values()].filter(
      (registration) =>
        registration.spaceId === source.spaceId &&
        (registration.scope === "browser" ||
          registration.targetId === source.targetId),
    );
    matches.sort((left, right) => {
      if (left.scope !== right.scope) return left.scope === "page" ? -1 : 1;
      return right.configuredAt - left.configuredAt;
    });
    return matches[0];
  }

  private async finishDownload(
    registration: DownloadRegistration,
    source: DownloadSource,
    guid: string,
    savePath: string,
    state: "completed" | "cancelled" | "interrupted",
    item: DownloadItem,
    initialTotalBytes: number,
  ) {
    let completed = state === "completed";
    if (completed) {
      try {
        await access(savePath, constants.R_OK);
      } catch {
        completed = false;
      }
    }
    this.emitProgress(
      registration,
      source,
      guid,
      completed ? "completed" : "canceled",
      safeItemValue(() => item.getReceivedBytes(), 0),
      safeItemValue(() => item.getTotalBytes(), initialTotalBytes),
    );
  }

  private reserveUniquePath(directory: string, filename: string) {
    const initial = join(directory, filename);
    if (!existsSync(initial) && !this.reservedPaths.has(initial)) {
      this.reservedPaths.add(initial);
      return initial;
    }
    const extension = extname(filename);
    const stem = extension ? filename.slice(0, -extension.length) : filename;
    for (let ordinal = 1; ordinal < 10_000; ordinal++) {
      const candidate = join(directory, `${stem} (${ordinal})${extension}`);
      if (existsSync(candidate) || this.reservedPaths.has(candidate)) continue;
      this.reservedPaths.add(candidate);
      return candidate;
    }
    const fallback = join(directory, `${stem}-${randomUUID()}${extension}`);
    this.reservedPaths.add(fallback);
    return fallback;
  }

  private emitWillBegin(
    registration: DownloadRegistration,
    source: DownloadSource,
    guid: string,
    url: string,
    suggestedFilename: string,
  ) {
    this.options.emit({
      connectionId: registration.connectionId,
      spaceId: source.spaceId,
      targetId: source.targetId,
      method: "Page.downloadWillBegin",
      params: {
        frameId: source.targetId,
        guid,
        url,
        suggestedFilename,
      },
    });
  }

  private emitProgress(
    registration: DownloadRegistration,
    source: DownloadSource,
    guid: string,
    state: "inProgress" | "completed" | "canceled",
    receivedBytes: number,
    totalBytes: number,
  ) {
    this.options.emit({
      connectionId: registration.connectionId,
      spaceId: source.spaceId,
      targetId: source.targetId,
      method: "Page.downloadProgress",
      params: { guid, state, receivedBytes, totalBytes },
    });
  }
}

function registrationKey(
  connectionId: string,
  spaceId: number,
  scope: DownloadScope,
  targetId: string,
) {
  return scope === "browser"
    ? `${connectionId}:${spaceId}:browser`
    : `${connectionId}:${spaceId}:page:${targetId}`;
}

function normalizeBehavior(value: unknown): DownloadBehavior {
  if (
    value === "default" ||
    value === "deny" ||
    value === "allow" ||
    value === "allowAndName"
  ) {
    return value;
  }
  throw new Error(`invalid download behavior: ${String(value)}`);
}

async function validateDownloadDirectory(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("downloadPath not provided");
  }
  if (!isAbsolute(value)) throw new Error("downloadPath must be absolute");
  const directory = value;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await stat(directory);
  if (!metadata.isDirectory()) throw new Error("downloadPath is not a directory");
  await access(directory, constants.R_OK | constants.W_OK);
  return directory;
}

function safeFilename(value: string) {
  const filename = basename(value.replaceAll("\0", "")).trim();
  return filename && filename !== "." && filename !== ".."
    ? filename
    : "download";
}

function safeItemValue<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
