import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import type { CdpEvent, CdpTransport } from "./cdp-transport.js";

export type NativeCefTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  parentId?: string;
  parentFrameId?: string;
  openerId?: string;
  browserContextId?: string;
  /** Native shared-host metadata, stripped from the CDP protocol itself. */
  ufoSpaceId?: number;
  webSocketDebuggerUrl?: string;
};

export type NativeCefVersion = {
  Browser: string;
  "Protocol-Version": string;
  UserAgent: string;
  webSocketDebuggerUrl?: string;
};

export type NativeCefRuntimeOptions = {
  executable?: string;
  url?: string;
  port?: number;
  startupTimeoutMs?: number;
  cwd?: string;
  userDataDir?: string;
  controlSocket?: string;
  /** UFO presentation channel used by the native Spaces button. */
  presentationSocket?: string;
  useMockKeychain?: boolean;
  overview?: boolean;
  /** Use Chromium's full native Chrome toolbar for a human-facing Space. */
  chromeShell?: boolean;
  /** Launch the Chromium-owned Product Shell directly (architecture probe). */
  nativeChromeProductShell?: boolean;
  /** Select a real Chrome Runtime profile directory such as Default/Profile 1. */
  chromeProfileDirectory?: string;
  /** Enable the private Chrome ProfileManager architecture probe commands. */
  chromeProfileManagerProbe?: boolean;
  /** UFO-owned native controller metadata shown in the Space titlebar. */
  spaceName?: string;
  profileName?: string;
  /** Show a Space immediately only for an explicit human-facing launch. */
  showOnStart?: boolean;
  /** Development/prototype manifest for multiple isolated Spaces in one host. */
  sharedSpaceManifest?: string;
  env?: NodeJS.ProcessEnv;
  /** Use the CEF-native DevTools message bridge over a private Unix socket. */
  devtoolsSocket?: string;
};

export type NativeCefSharedSpaceSpec = {
  id: number;
  url: string;
  cachePath: string;
  name?: string;
  profileName?: string;
  visible?: boolean;
  /** False for internal Profile transactions that need no human Chrome UI. */
  chromeShell?: boolean;
  /** Full Chromium-owned Chrome window with native tab strip and omnibox. */
  nativeChromeShell?: boolean;
  /** Real Chrome Runtime ProfileManager directory for persistent Spaces. */
  chromeProfileDirectory?: string;
  /** Shared Chrome user-data root owned by the single UFO CEF host. */
  chromeUserDataRoot?: string;
};

type NativeCefSpaceBrowser = {
  browserId: number;
  route: string;
  primary: boolean;
  url: string;
};

type NativeBrowserFrameRoute = {
  rootId?: string;
  frameIds: Set<string>;
};

type PendingCommand = {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
};

type NativeWebSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
};

export type NativeCdpConnectionLike = {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  onEvent(listener: (message: CdpEvent) => void): () => void;
  close(): Promise<void>;
};

const OPEN = 1;

export class NativeCdpConnection {
  private readonly socket: NativeWebSocket;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly eventListeners = new Set<(message: CdpEvent) => void>();
  private nextId = 1;
  private closed = false;
  private readonly ready: Promise<void>;

  constructor(
    webSocketUrl: string,
    onEvent?: (message: CdpEvent) => void,
  ) {
    const WebSocketCtor = (globalThis as any).WebSocket;
    if (typeof WebSocketCtor !== "function") {
      throw new Error("Native CEF CDP requires a runtime with WebSocket support");
    }
    this.socket = new WebSocketCtor(webSocketUrl) as NativeWebSocket;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.socket.addEventListener("open", () => resolveReady());
      this.socket.addEventListener("error", () => {
        rejectReady(new Error("Native CEF CDP WebSocket failed to connect"));
      });
    });
    this.socket.addEventListener("message", (event) => this.receive(event.data));
    this.socket.addEventListener("close", () => this.failPending("Native CEF CDP connection closed"));
    this.socket.addEventListener("error", () => this.failPending("Native CEF CDP WebSocket error"));
    if (onEvent) this.eventListeners.add(onEvent);
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) {
    await this.ready;
    if (this.closed || this.socket.readyState !== OPEN) {
      throw new Error("Native CEF CDP connection is closed");
    }
    const id = this.nextId++;
    return new Promise<any>((resolveResult, rejectResult) => {
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async close() {
    this.closed = true;
    this.failPending("Native CEF CDP connection closed");
    if (this.socket.readyState !== 3) this.socket.close();
  }

  onEvent(listener: (message: CdpEvent) => void) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private receive(raw: unknown) {
    let message: any;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (Number.isInteger(message?.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(String(message.error.message || "Native CEF CDP error")));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message?.method === "string") {
      for (const listener of this.eventListeners) listener(message as CdpEvent);
    }
  }

  private failPending(message: string) {
    if (this.pending.size === 0) return;
    const error = new Error(message);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

/** CEF's DevTools WebSocket as a UFO browser-protocol transport. */
export class NativeCefCdpTransport implements CdpTransport {
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly connection: NativeCdpConnection;

  constructor(webSocketUrl: string) {
    this.connection = new NativeCdpConnection(webSocketUrl, (event) => {
      for (const listener of this.listeners) listener(event);
    });
  }

  sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    return this.connection.send(method, params, sessionId);
  }

  onEvent(listener: (event: CdpEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.listeners.clear();
    return this.connection.close();
  }
}

/** Standard-CDP JSON over the private CEF Unix-socket bridge. */
export class NativeCefPrivateConnection implements NativeCdpConnectionLike {
  private readonly socket: ReturnType<typeof createConnection>;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Set<(message: CdpEvent) => void>();
  private readonly ready: Promise<void>;
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private defaultSessionId?: string;

  constructor(
    private readonly socketPath: string,
    private readonly targetId: string,
    /**
     * Bridge-only browser route used when multiple isolated BrowserViews live
     * in one UFO CEF host process. This value is removed by the native bridge
     * before the CDP message is forwarded to Chromium.
     */
    private readonly browserRoute?: string,
  ) {
    this.socket = createConnection(socketPath);
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.socket.once("connect", resolveReady);
      this.socket.once("error", rejectReady);
    });
    this.socket.on("connect", () => this.socket.setNoDelay(true));
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.receive(String(chunk)));
    this.socket.on("error", (error) => this.failPending(error instanceof Error ? error : new Error(String(error))));
    this.socket.on("close", () => this.failPending(new Error("Native CEF private DevTools socket closed")));
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    await this.ready;
    if (this.closed) throw new Error("Native CEF private DevTools connection is closed");
    const id = this.nextId++;
    return new Promise<any>((resolveResult, rejectResult) => {
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult });
      const routedSessionId = sessionId || this.defaultSessionId;
      this.socket.write(`${JSON.stringify({
        id,
        targetId: this.targetId,
        ...(this.browserRoute ? { browserRoute: this.browserRoute } : {}),
        method,
        params,
        ...(routedSessionId ? { sessionId: routedSessionId } : {}),
      })}\n`);
    });
  }

  setDefaultSessionId(sessionId: string) {
    this.defaultSessionId = sessionId;
  }

  private sendWithSession(method: string, params: Record<string, unknown>, sessionId: string) {
    return this.send(method, params, sessionId);
  }

  onEvent(listener: (message: CdpEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {
    this.closed = true;
    this.failPending(new Error("Native CEF private DevTools connection closed"));
    this.socket.destroy();
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let newline = 0;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      if (Number.isInteger(message?.id)) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(String(message.error.message || "Native CEF DevTools error")));
          else pending.resolve(message.result);
        }
        // A private CEF observer broadcasts the same CDP result/event stream to
        // every route registered on a browser. A response for another route
        // must not discard a valid event that happens to include an id field.
        // Standard CDP responses have no method; fall through for method events.
        if (typeof message?.method !== "string") continue;
      }
      if (typeof message?.method === "string") {
        for (const listener of this.listeners) listener(message as CdpEvent);
      }
    }
  }

  private failPending(error: Error) {
    if (this.pending.size === 0) return;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export class NativeCefRuntime {
  private process?: ChildProcess;
  private attached = false;
  private readonly connections = new Set<NativeCdpConnection>();
  private port?: number;
  private versionInfo?: NativeCefVersion;
  private controlSocketPath?: string;
  private devtoolsSocketPath?: string;

  constructor(private readonly defaults: NativeCefRuntimeOptions = {}) {}

  isRunning() {
    return this.attached || Boolean(this.process && this.process.exitCode === null && !this.process.killed);
  }

  getPort() {
    return this.port;
  }

  usesPrivateBridge() {
    return Boolean(this.devtoolsSocketPath);
  }

  async start(options: NativeCefRuntimeOptions = {}) {
    if (this.isRunning()) return this.version();
    if (process.platform !== "darwin") throw new Error("Native CEF currently supports macOS only");
    const merged = { ...this.defaults, ...options };
    const port = merged.port ?? 9222;
    if (!merged.devtoolsSocket && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
      throw new Error(`Invalid Native CEF DevTools port: ${port}`);
    }
    const executable = await resolveExecutable(merged.executable);
    this.port = port;
    this.controlSocketPath = merged.controlSocket ? resolve(merged.controlSocket) : undefined;
    this.devtoolsSocketPath = merged.devtoolsSocket ? resolve(merged.devtoolsSocket) : undefined;
    const args = buildNativeCefArgs(merged, port);
    this.process = spawn(executable, args, {
      cwd: merged.cwd,
      env: { ...process.env, ...merged.env },
      // Keep release launches quiet, but allow focused shared-host debugging
      // without changing the process topology or the private bridge.
      stdio: process.env.UFO_CEF_DEBUG_STDIO === "1" ? "inherit" : "ignore",
      // CEF launches GPU/renderer/utility helpers. Put the host in its own
      // process group so a bounded shutdown can reap the entire runtime tree
      // instead of leaving Chromium helpers behind when a renderer stalls.
      detached: true,
    });
    this.process.once("exit", () => {
      this.process = undefined;
      this.versionInfo = undefined;
      for (const connection of this.connections) void connection.close();
      this.connections.clear();
    });
    try {
      this.versionInfo = await this.waitForVersion(merged.startupTimeoutMs ?? 15_000);
      return this.versionInfo;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /**
   * Attach the Agent service to the CEF host that is already the UFO product
   * main process. This is the packaged-app direction: Node never launches a
   * second browser host, it only connects to the private control/CDP sockets
   * owned by the running UFO-Browser executable.
   */
  async attach(options: NativeCefRuntimeOptions = {}) {
    if (this.isRunning()) return this.version();
    const merged = { ...this.defaults, ...options };
    if (!merged.devtoolsSocket) {
      throw new Error("Attached Native CEF host requires a private DevTools socket");
    }
    if (!merged.controlSocket) {
      throw new Error("Attached Native CEF host requires a control socket");
    }
    this.port = merged.port;
    this.controlSocketPath = resolve(merged.controlSocket);
    this.devtoolsSocketPath = resolve(merged.devtoolsSocket);
    this.attached = true;
    try {
      this.versionInfo = await this.waitForVersion(merged.startupTimeoutMs ?? 15_000);
      return this.versionInfo;
    } catch (error) {
      this.attached = false;
      this.port = undefined;
      this.controlSocketPath = undefined;
      this.devtoolsSocketPath = undefined;
      throw error;
    }
  }

  async version() {
    if (!this.port && !this.devtoolsSocketPath) throw new Error("Native CEF runtime is not started");
    if (this.versionInfo) return this.versionInfo;
    if (this.devtoolsSocketPath) {
      const connection = new NativeCefPrivateConnection(this.devtoolsSocketPath, "browser");
      try { return (this.versionInfo = await connection.send("Browser.getVersion")); }
      finally { await connection.close(); }
    }
    this.versionInfo = await fetchJson<NativeCefVersion>(this.endpoint("/json/version"));
    return this.versionInfo;
  }

  async targets(): Promise<NativeCefTarget[]> {
    if (this.devtoolsSocketPath) {
      const connection = new NativeCefPrivateConnection(this.devtoolsSocketPath, "browser");
      try {
        const result = await connection.send("Target.getTargets");
        return (result?.targetInfos || []).map((target: any) => ({
          id: target.targetId,
          type: target.type,
          title: target.title,
          url: target.url,
          parentId: target.parentId,
          parentFrameId: target.parentFrameId,
          openerId: target.openerId,
          browserContextId: target.browserContextId,
          ufoSpaceId: Number.isInteger(target.ufoSpaceId) ? target.ufoSpaceId : undefined,
        }));
      } finally { await connection.close(); }
    }
    if (!this.port) throw new Error("Native CEF runtime is not started");
    return fetchJson<NativeCefTarget[]>(this.endpoint("/json/list"));
  }

  async connect(targetId?: string, browserRoute?: string) {
    if (this.devtoolsSocketPath) {
      const connection = new NativeCefPrivateConnection(
        this.devtoolsSocketPath,
        "browser",
        browserRoute,
      );
      if (targetId) {
        const target = (await this.targets()).find((candidate) => candidate.id === targetId);
        const attached = await attachPrivateTarget(connection, targetId);
        connection.setDefaultSessionId(String(attached.sessionId));
        // Page and iframe renderers can briefly report about:blank during
        // initial navigation. Internal targets and freshly-created popups may
        // legitimately have an empty URL, so only wait when a non-blank
        // document URL is already known.
        if ((target?.type === "page" || target?.type === "iframe") &&
            target.url && target.url !== "about:blank") {
          await waitForPrivatePage(connection, 15_000);
        }
      }
      return connection;
    }
    const targets = await this.targets();
    const target = targetId
      ? targets.find((candidate) => candidate.id === targetId)
      : targets.find((candidate) => candidate.type === "page");
    if (!target?.webSocketDebuggerUrl) throw new Error(`Native CEF target not found: ${targetId || "page"}`);
    const connection = new NativeCdpConnection(target.webSocketDebuggerUrl);
    this.connections.add(connection);
    return connection;
  }

  /** Attach without waiting for document navigation; used for volatile OOPIF targets. */
  async connectRaw(targetId: string, browserRoute?: string) {
    if (!this.devtoolsSocketPath) return this.connect(targetId, browserRoute);
    const connection = new NativeCefPrivateConnection(
      this.devtoolsSocketPath,
      "browser",
      browserRoute,
    );
    const attached = await attachPrivateTarget(connection, targetId);
    connection.setDefaultSessionId(String(attached.sessionId));
    return connection;
  }

  async connectBrowser(browserRoute?: string) {
    if (this.devtoolsSocketPath) {
      return new NativeCefPrivateConnection(
        this.devtoolsSocketPath,
        "browser",
        browserRoute,
      );
    }
    const version = await this.version();
    if (!version.webSocketDebuggerUrl) {
      throw new Error("Native CEF browser DevTools target is unavailable");
    }
    const connection = new NativeCdpConnection(version.webSocketDebuggerUrl);
    this.connections.add(connection);
    return connection;
  }

  async stop() {
    for (const connection of this.connections) await connection.close();
    this.connections.clear();
    const child = this.process;
    this.process = undefined;
    this.versionInfo = undefined;
    this.port = undefined;
    this.controlSocketPath = undefined;
    this.devtoolsSocketPath = undefined;
    if (this.attached) {
      this.attached = false;
      return;
    }
    if (!child || child.killed) return;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
        resolveStop();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
      // Terminate the browser process first and let CEF shut its helpers down
      // in dependency order. Sending SIGTERM to the complete detached process
      // group kills the storage/network services before cookie and Profile
      // flushes complete. The timer above still removes a wedged process tree.
      child.kill("SIGTERM");
    });
  }

  async control(command: "show" | "hide" | "focus" | "close" | "status" | "wake" | "sleep" | "agent-active-on" | "agent-active-off") {
    return this.sendControlPayload(command);
  }

  async createSharedSpace(space: NativeCefSharedSpaceSpec) {
    const response = await this.sendControlPayload(JSON.stringify({
      command: "create-space",
      space,
    }));
    if (response.startsWith("error ")) throw new Error(response);
    const result = JSON.parse(response);
    if (!result?.ok || result.spaceId !== space.id) {
      throw new Error(`Native CEF shared Space creation failed: ${response}`);
    }
    return result as { ok: true; spaceId: number; browserRoute: string };
  }

  async probeChromeProfileManager(
    command: "list-contexts" | "add-profile" | "manage-profiles",
  ) {
    const response = await this.sendControlPayload(JSON.stringify({
      command: "chrome-profile-manager-probe",
      action: command,
    }));
    if (response.startsWith("error ")) throw new Error(response);
    return JSON.parse(response);
  }

  async presentationStatus() {
    const response = await this.sendControlPayload(JSON.stringify({
      command: "presentation-status",
    }));
    if (response.startsWith("error ")) throw new Error(response);
    return JSON.parse(response);
  }

  async controlSharedSpace(
    spaceId: number,
    command:
      | "show-space"
      | "hide-space"
      | "focus-space"
      | "close-space"
      | "status-space"
      | "wake-space"
      | "sleep-space"
      | "create-space-tab"
      | "agent-active-space-on"
      | "agent-active-space-off",
  ) {
    const response = await this.sendControlPayload(JSON.stringify({ command, spaceId }));
    if (response.startsWith("error ")) throw new Error(response);
    return response;
  }

  async updateSharedSpaceAgentOverlay(
    spaceId: number,
    title: string,
    detail: string,
  ) {
    const response = await this.sendControlPayload(JSON.stringify({
      command: "agent-overlay-state",
      spaceId,
      title,
      detail,
    }));
    if (response.startsWith("error ")) throw new Error(response);
    return response;
  }

  async showSharedSpaceAgentPointer(
    spaceId: number,
    x: number,
    y: number,
    label = "正在浏览网页",
  ) {
    const response = await this.sendControlPayload(JSON.stringify({
      command: "agent-pointer-space",
      spaceId,
      x,
      y,
      label,
    }));
    if (response.startsWith("error ")) throw new Error(response);
    return response;
  }

  async listSharedSpaceBrowsers(spaceId: number): Promise<NativeCefSpaceBrowser[]> {
    const response = await this.sendControlPayload(JSON.stringify({
      command: "list-space-browsers",
      spaceId,
    }));
    if (response.startsWith("error ")) throw new Error(response);
    let result: any;
    try {
      result = JSON.parse(response);
    } catch (error) {
      throw new Error(`Invalid Native CEF Space browser response ${JSON.stringify(response)}: ${String(error)}`);
    }
    return Array.isArray(result?.browsers) ? result.browsers : [];
  }

  private async sendControlPayload(payload: string) {
    const path = this.controlSocketPath || this.defaults.controlSocket;
    if (!path) throw new Error("Native CEF control socket is not configured");
    const deadline = Date.now() + 5_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await sendControlCommand(path, payload);
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    }
    throw new Error(`Native CEF control socket unavailable: ${String(lastError || path)}`);
  }

  hasExited() {
    // The exit handler clears the ChildProcess reference deliberately. A
    // missing reference is therefore also a stale runtime and callers may
    // safely recreate it instead of retrying a dead control socket forever.
    return !this.isRunning();
  }

  private endpoint(path: string) {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  private async waitForVersion(timeoutMs: number) {
    if (this.devtoolsSocketPath) {
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          const connection = new NativeCefPrivateConnection(this.devtoolsSocketPath, "browser");
          const version = await connection.send("Browser.getVersion");
          await connection.close();
          return version as NativeCefVersion;
        } catch (error) {
          lastError = error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        }
      }
      throw new Error(`Native CEF private DevTools bridge did not become ready: ${String(lastError || "timeout")}`);
    }
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await fetchJson<NativeCefVersion>(this.endpoint("/json/version"));
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    }
    throw new Error(`Native CEF DevTools did not become ready: ${String(lastError || "timeout")}`);
  }
}

/**
 * A logical Space hosted inside one shared Native CEF process.
 *
 * This adapter intentionally matches NativeCefRuntime's public surface so the
 * Agent, snapshot, profile-sync, and CDP broker layers do not need a second
 * protocol. Process ownership remains with the shared host; closing a Space
 * destroys only its BrowserView/RequestContext.
 */
export class NativeCefSharedSpaceRuntime extends NativeCefRuntime {
  private started = false;
  private readonly browserRoute: string;
  private readonly ownedTargetIds = new Set<string>();
  private readonly targetProbeAt = new Map<string, number>();
  private readonly directTargetRoutes = new Map<string, string>();
  // A real Chrome Profile exposes a process-wide Target.getTargets result,
  // while each exact WebContents route has its own frame tree. Probing every
  // route on every targets() call opens a short-lived DevTools connection and
  // can make Chromium's browser-info manager time out under preview/Agent
  // polling. Root frame ids are stable across ordinary navigation, so keep a
  // route-scoped frame tree and only reprobe when a browser is new or its root
  // target has genuinely disappeared.
  private readonly directBrowserFrames = new Map<number, NativeBrowserFrameRoute>();
  private readonly directBrowserFrameMissingSince = new Map<number, number>();
  private browserContextId?: string;

  constructor(
    private readonly host: NativeCefRuntime,
    private readonly space: NativeCefSharedSpaceSpec,
  ) {
    super();
    this.browserRoute = `space:${space.id}`;
  }

  override isRunning() {
    return this.started && this.host.isRunning();
  }

  override getPort() {
    return this.host.getPort();
  }

  override usesPrivateBridge() {
    return this.host.usesPrivateBridge();
  }

  override async start() {
    if (this.isRunning()) return this.host.version();
    if (!this.host.isRunning()) {
      throw new Error("Native CEF shared host is not running");
    }
    await this.host.createSharedSpace(this.space);
    const deadline = Date.now() + 15_000;
    let browsers: NativeCefSpaceBrowser[] = [];
    while (Date.now() < deadline) {
      browsers = await this.host.listSharedSpaceBrowsers(this.space.id)
        .catch(() => []);
      if (browsers.some((browser) => browser.primary)) {
        this.started = true;
        return this.host.version();
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw new Error(
      `Native CEF shared Space ${this.space.id} browser route did not become ready: ${JSON.stringify(browsers)}`,
    );
  }

  override version() {
    return this.host.version();
  }

  override async targets(): Promise<NativeCefTarget[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const connection = await this.host.connectBrowser(this.browserRoute);
      try {
        const result = await connection.send("Target.getTargets");
        const infos = result?.targetInfos || [];
        const selected = new Set<string>();
        const realChromeProfile = Boolean(this.space.chromeProfileDirectory);
        const spaceBrowsers = prioritizeNativeSpaceBrowsers(
          await this.host.listSharedSpaceBrowsers(this.space.id),
        );
        const directBrowserFrames = realChromeProfile
          ? await this.resolveDirectBrowserFrames(spaceBrowsers, infos)
          : new Map<number, NativeBrowserFrameRoute>();
        const directRootTargets = new Map<string, string>();
        for (const browser of spaceBrowsers) {
          const frameRoute = directBrowserFrames.get(browser.browserId);
          if (!frameRoute?.rootId) continue;
          const syntheticId = `cef-browser:${browser.browserId}`;
          directRootTargets.set(frameRoute.rootId, syntheticId);
          this.ownedTargetIds.add(frameRoute.rootId);
          for (const frameId of frameRoute.frameIds) selected.add(frameId);
        }
        const routedFrameTree = !realChromeProfile
          ? await connection.send("Page.getFrameTree").catch(() => undefined)
          : undefined;
        const routedFrameId = routedFrameTree?.frameTree?.frame?.id ||
          routedFrameTree?.result?.frameTree?.frame?.id;
        const routedPrimaryTargetId = routedFrameId &&
          infos.some((target: any) => target.targetId === routedFrameId)
            ? String(routedFrameId)
            : undefined;
        if (routedPrimaryTargetId) {
          selected.add(routedPrimaryTargetId);
        }
        for (const target of infos) {
          if (this.ownedTargetIds.has(target.targetId) ||
              target.ufoSpaceId === this.space.id) {
            selected.add(target.targetId);
          }
        }
        // Chrome Runtime's Target.getTargets is process-wide even when the
        // request is sent through a browser route. On first discovery, use a
        // small page-side marker injected by the native host to associate each
        // target with its logical Space. This avoids guessing by URL, which
        // breaks when two Spaces are both on Google or a restored page.
        for (const target of infos) {
          if (target.type !== "page" || selected.has(target.targetId)) continue;
          if (realChromeProfile) continue;
          const lastProbe = this.targetProbeAt.get(target.targetId) || 0;
          if (Date.now() - lastProbe < 500) continue;
          this.targetProbeAt.set(target.targetId, Date.now());
          const owner = await probeTargetSpace(connection, target.targetId);
          if (owner === this.space.id) {
            this.ownedTargetIds.add(target.targetId);
            selected.add(target.targetId);
          }
        }
        // Custom CEF RequestContexts map one browserContextId to one logical
        // Space, so context expansion is useful there. A real Chrome Profile
        // intentionally shares its browserContextId across Overview and every
        // Space using that Profile; expanding it would leak Overview/sibling
        // tabs into this Space. Real Profile ownership therefore stays on the
        // exact routed CefBrowser, frame/opener graph, and native browser list.
        if (!realChromeProfile) {
          for (const target of infos) {
            if (selected.has(target.targetId) && target.browserContextId) {
              this.browserContextId ||= String(target.browserContextId);
            }
          }
          if (this.browserContextId) {
            for (const target of infos) {
              if (target.browserContextId === this.browserContextId) {
                selected.add(target.targetId);
              }
            }
          }
        }
        // window.open targets declare their opener before their page marker is
        // necessarily available. Keep following the opener chain so a popup
        // becomes visible to Agent APIs in the first enumeration cycle.
        let addedOpener = true;
        while (addedOpener) {
          addedOpener = false;
          for (const target of infos) {
            if (!selected.has(target.targetId) && target.openerId && selected.has(target.openerId)) {
              selected.add(target.targetId);
              addedOpener = true;
            }
          }
        }
        // The cached direct frame tree intentionally avoids a DevTools probe
        // on every poll. New OOPIFs can still appear between polls, so follow
        // the target parent graph until it reaches a fixed point and include
        // those children without reopening the browser route.
        let addedFrame = true;
        while (addedFrame) {
          addedFrame = false;
          for (const target of infos) {
            if (target.type === "iframe" &&
                !selected.has(target.targetId) &&
                selected.has(target.parentId)) {
              selected.add(target.targetId);
              addedFrame = true;
            }
          }
        }
        const remapParentTarget = (targetId: unknown) =>
          typeof targetId === "string"
            ? directRootTargets.get(targetId) || targetId
            : undefined;
        const targets: NativeCefTarget[] = infos
          // Keep the exact UUID selected so OOPIF/opener relationships can be
          // followed, but expose the primary page through its direct
          // CefBrowser route below. Attaching back to the primary UUID through
          // CEF's browser-level endpoint can stall Chrome Runtime even though
          // direct Runtime/Page commands on that CefBrowser are reliable.
          .filter((target: any) =>
            selected.has(target.targetId) &&
            target.targetId !== routedPrimaryTargetId &&
            !directRootTargets.has(target.targetId))
          .map((target: any) => ({
            id: target.targetId,
            type: target.type,
            title: target.title,
            url: target.url,
            parentId: remapParentTarget(target.parentId),
            parentFrameId: remapParentTarget(target.parentFrameId),
            openerId: remapParentTarget(target.openerId),
            browserContextId: target.browserContextId,
            ufoSpaceId: this.space.id,
          }));
        // Chrome Runtime creates window.open()/popup surfaces as sibling
        // CefBrowser instances. They live in this same UFO process and share
        // the Space RequestContext, but Chromium does not expose them through
        // the primary Browser's Target.getTargets result. Publish a stable
        // synthetic page target backed by that CefBrowser's direct DevTools
        // endpoint so Agent tab/popup APIs see the complete logical Space.
        // Chrome Runtime may report a transient/sibling CefBrowser before the
        // Browser that UFO registered as this Space's primary route. Cookie
        // initialization and the first page readiness probe both select the
        // first page target, so returning an auxiliary route first can stall
        // on Chromium's browser-info handshake even though the primary page
        // is already ready. Preserve every popup/tab, but make primary-first
        // ordering an explicit protocol invariant.
        this.directTargetRoutes.clear();
        const hasDiscoveredPrimaryPage = !realChromeProfile && targets.some((target) =>
          target.type === "page" && !target.id.startsWith("cef-browser:"),
        );
        for (const browser of spaceBrowsers) {
          const id = `cef-browser:${browser.browserId}`;
          this.directTargetRoutes.set(id, browser.route);
          const frameRoute = directBrowserFrames.get(browser.browserId);
          if (frameRoute?.rootId) {
            this.directTargetRoutes.set(frameRoute.rootId, browser.route);
          }
          // A real Chrome Profile may be shared with the internal Overview or
          // another Space. In that case browser-level Target.getTargets is
          // process-wide and CEF can reject cross-WebContents attachment while
          // the page marker is being probed. The primary CefBrowser route is
          // already exact, so publish it as a stable synthetic target whenever
          // UUID discovery did not identify this Space's primary page.
          if (browser.primary && hasDiscoveredPrimaryPage) continue;
          const exactTarget = frameRoute?.rootId
            ? infos.find((candidate: any) => candidate.targetId === frameRoute.rootId)
            : undefined;
          targets.push({
            id,
            type: "page",
            title: exactTarget?.title || "",
            url: exactTarget?.url || browser.url || "about:blank",
            openerId: remapParentTarget(exactTarget?.openerId),
            browserContextId: exactTarget?.browserContextId,
            ufoSpaceId: this.space.id,
          });
        }
        return targets;
      } catch (error) {
        lastError = error;
      } finally {
        await connection.close();
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Native CEF shared Space route did not become ready: ${String(lastError || this.browserRoute)}`);
  }

  private async resolveDirectBrowserFrames(
    browsers: readonly NativeCefSpaceBrowser[],
    infos: readonly any[],
  ) {
    const availableTargetIds = new Set(
      infos
        .map((target: any) => target?.targetId)
        .filter((targetId: unknown): targetId is string =>
          typeof targetId === "string" && targetId.length > 0),
    );
    const activeBrowserIds = new Set(browsers.map((browser) => browser.browserId));
    for (const browserId of this.directBrowserFrames.keys()) {
      if (!activeBrowserIds.has(browserId)) {
        this.directBrowserFrames.delete(browserId);
        this.directBrowserFrameMissingSince.delete(browserId);
      }
    }

    const routes = new Map<number, NativeBrowserFrameRoute>();
    for (const browser of browsers) {
      const cached = this.directBrowserFrames.get(browser.browserId);
      if (cached?.rootId && availableTargetIds.has(cached.rootId)) {
        this.directBrowserFrameMissingSince.delete(browser.browserId);
        routes.set(browser.browserId, cached);
        continue;
      }

      // Target.getTargets can briefly omit a target while Chromium is
      // replacing a renderer. Keep the last exact frame graph for a short
      // grace period instead of opening another DevTools route on every poll.
      // If the root remains absent past the grace period, refresh it once.
      if (cached) {
        const missingSince = this.directBrowserFrameMissingSince.get(browser.browserId) ?? Date.now();
        this.directBrowserFrameMissingSince.set(browser.browserId, missingSince);
        if (Date.now() - missingSince < 1_000) {
          routes.set(browser.browserId, cached);
          continue;
        }
      }

      const fresh = await inspectNativeSpaceBrowserFrame(this.host, browser);
      if (fresh.rootId) {
        this.directBrowserFrames.set(browser.browserId, fresh);
        this.directBrowserFrameMissingSince.delete(browser.browserId);
        routes.set(browser.browserId, fresh);
      } else {
        // Do not retain a closed browser's synthetic target forever. The
        // shared host will publish it again when the route becomes ready.
        this.directBrowserFrames.delete(browser.browserId);
        this.directBrowserFrameMissingSince.delete(browser.browserId);
      }
    }
    return routes;
  }

  override connect(targetId?: string) {
    const directRoute = targetId ? this.directTargetRoutes.get(targetId) : undefined;
    if (directRoute) return this.host.connectBrowser(directRoute);
    return this.host.connect(targetId, this.browserRoute);
  }

  override connectRaw(targetId: string) {
    const directRoute = this.directTargetRoutes.get(targetId);
    if (directRoute) return this.host.connectBrowser(directRoute);
    return this.host.connectRaw(targetId, this.browserRoute);
  }

  override connectBrowser() {
    return this.host.connectBrowser(this.browserRoute);
  }

  rememberTargetId(targetId: string) {
    if (targetId) this.ownedTargetIds.add(targetId);
  }

  async createTarget(url: string) {
    const before = new Set(
      (await this.targets())
        .filter((target) => target.type === "page")
        .map((target) => target.id),
    );
    await this.host.controlSharedSpace(this.space.id, "create-space-tab");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const target = (await this.targets()).find(
        (candidate) => candidate.type === "page" && !before.has(candidate.id),
      );
      if (target) {
        this.rememberTargetId(target.id);
        if (url && url !== "about:blank") {
          const connection = await this.connect(target.id);
          try {
            await connection.send("Page.navigate", { url });
          } finally {
            await connection.close();
          }
        }
        return { targetId: target.id };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw new Error("Native CEF Chrome command did not create a Space tab");
  }

  override async stop() {
    if (!this.started) return;
    await this.host.controlSharedSpace(this.space.id, "close-space").catch(() => undefined);
    // `close-space` initiates CEF/AppKit teardown but returns before
    // OnWindowDestroyed unregisters the RequestContext. Profile transactions
    // must wait for that boundary so their partition is no longer receiving
    // Chromium writes when import/clone publishes it.
    const deadline = Date.now() + 5_000;
    while (this.host.isRunning() && Date.now() < deadline) {
      try {
        await this.host.controlSharedSpace(this.space.id, "status-space");
      } catch (error) {
        if (String(error).includes("space-not-found") || !this.host.isRunning()) {
          this.started = false;
          return;
        }
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    this.started = false;
    if (this.host.isRunning()) {
      throw new Error(`Native CEF shared Space ${this.space.id} did not finish closing`);
    }
  }

  override async control(
    command: "show" | "hide" | "focus" | "close" | "status" | "wake" | "sleep" | "agent-active-on" | "agent-active-off",
  ) {
    const routed = {
      show: "show-space",
      hide: "hide-space",
      focus: "focus-space",
      close: "close-space",
      status: "status-space",
      wake: "wake-space",
      sleep: "sleep-space",
      "agent-active-on": "agent-active-space-on",
      "agent-active-off": "agent-active-space-off",
    } as const;
    const response = await this.host.controlSharedSpace(this.space.id, routed[command]);
    if (command === "close") this.started = false;
    return response;
  }

  override hasExited() {
    return !this.isRunning();
  }
}

export function prioritizeNativeSpaceBrowsers(
  browsers: readonly NativeCefSpaceBrowser[],
) {
  return [...browsers].sort((left, right) =>
    Number(right.primary) - Number(left.primary));
}

/**
 * Resolve the DevTools frame id for each exact CEF WebContents route. Chrome's
 * Browser.getTargets endpoint is process-wide when a real Profile is shared,
 * while a direct browser route is scoped to one tab. We use that scoped route
 * to map the raw UUID page/iframe graph back to the stable UFO tab target.
 */
async function inspectNativeSpaceBrowserFrame(
  host: NativeCefRuntime,
  browser: NativeCefSpaceBrowser,
) {
  const frameRoute: NativeBrowserFrameRoute = { frameIds: new Set<string>() };
  let connection: NativeCdpConnectionLike | undefined;
  try {
    connection = await host.connectBrowser(browser.route);
    const frameTree = await connection.send("Page.getFrameTree");
    const tree = frameTree?.frameTree || frameTree?.result?.frameTree;
    collectNativeFrameIds(tree, frameRoute.frameIds);
    const rootId = tree?.frame?.id;
    if (typeof rootId === "string" && rootId) frameRoute.rootId = rootId;
  } catch {
    // A tab can disappear between list-space-browsers and this probe. The
    // next targets() pass will retry it, while other tabs remain usable.
  } finally {
    await connection?.close().catch(() => undefined);
  }
  return frameRoute;
}

export function collectNativeFrameIds(frameTree: any, result = new Set<string>()) {
  const frameId = frameTree?.frame?.id;
  if (typeof frameId === "string" && frameId) result.add(frameId);
  for (const child of frameTree?.childFrames || []) {
    collectNativeFrameIds(child, result);
  }
  return result;
}

export function collectNativeDomFrameIds(node: any, result = new Set<string>()) {
  if (typeof node?.frameId === "string" && node.frameId) {
    result.add(node.frameId);
  }
  for (const child of node?.children || []) {
    collectNativeDomFrameIds(child, result);
  }
  for (const shadowRoot of node?.shadowRoots || []) {
    collectNativeDomFrameIds(shadowRoot, result);
  }
  if (node?.contentDocument) {
    collectNativeDomFrameIds(node.contentDocument, result);
  }
  return result;
}

async function probeTargetSpace(
  connection: { send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any> },
  targetId: string,
) {
  try {
    const attached = await connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = String(attached?.sessionId || "");
    if (!sessionId) return undefined;
    const result = await connection.send("Runtime.evaluate", {
      expression: "globalThis.__ufoSpaceId",
      returnByValue: true,
    }, sessionId);
    await connection.send("Target.detachFromTarget", { sessionId });
    const value = result?.result?.value;
    return Number.isInteger(value) ? Number(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the native host command line in one place so every launch path keeps
 * the same Chrome-shell contract. Overview is intentionally a UFO management
 * page without browser chrome; human-facing Spaces explicitly opt into the
 * CEF native tabs/omnibox/profile controls.
 */
export function buildNativeCefArgs(options: NativeCefRuntimeOptions, port = options.port ?? 9222) {
  const args = [
    `--url=${options.url || "https://www.google.com/"}`,
    ...(options.devtoolsSocket
      ? [`--devtools-socket=${resolve(options.devtoolsSocket)}`]
      : [`--agent-devtools-port=${port}`]),
  ];
  if (options.userDataDir) args.push(`--user-data-dir=${resolve(options.userDataDir)}`);
  if (options.controlSocket) args.push(`--control-socket=${resolve(options.controlSocket)}`);
  if (options.presentationSocket) args.push(`--presentation-socket=${resolve(options.presentationSocket)}`);
  if (options.useMockKeychain) args.push("--use-mock-keychain");
  if (options.overview) args.push("--overview");
  if (options.nativeChromeProductShell) args.push("--native-chrome-product-shell");
  if (options.chromeProfileManagerProbe) args.push("--chrome-profile-manager-probe");
  if (options.chromeProfileDirectory) {
    if (options.chromeProfileDirectory.includes("/") ||
        options.chromeProfileDirectory.includes("\\") ||
        options.chromeProfileDirectory === "." ||
        options.chromeProfileDirectory === "..") {
      throw new Error(`Invalid Chrome profile directory: ${options.chromeProfileDirectory}`);
    }
    args.push(`--profile-directory=${options.chromeProfileDirectory}`);
  }
  // Keep the mode explicit in production launches. The host also defaults to
  // this mode for direct non-Overview runs, while --plain-page remains an
  // intentional diagnostic escape hatch for CEF host development.
  if (!options.overview && options.chromeShell !== false) args.push("--chrome-shell");
  if (!options.overview && options.spaceName) args.push(`--space-name=${encodeURIComponent(options.spaceName)}`);
  if (!options.overview && options.profileName) args.push(`--profile-name=${encodeURIComponent(options.profileName)}`);
  if (options.showOnStart) args.push("--show-on-start");
  if (options.sharedSpaceManifest) {
    args.push(`--shared-space-manifest=${resolve(options.sharedSpaceManifest)}`);
  }
  return args;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the check and kill. Fall back to
      // the ChildProcess handle for platforms that do not expose groups.
    }
  }
  child.kill(signal);
}

async function attachPrivateTarget(connection: NativeCefPrivateConnection, targetId: string, attempts = 8) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const attached = await connection.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const sessionId = attached?.sessionId || attached?.result?.sessionId;
      if (sessionId) return { sessionId: String(sessionId) };
      lastError = new Error("CEF returned no sessionId");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 75 * (attempt + 1)));
  }
  await connection.close();
  throw new Error(`Native CEF private target attach failed: ${targetId}: ${String(lastError || "no session")}`);
}

async function waitForPrivatePage(connection: NativeCefPrivateConnection, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await connection.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    }).catch(() => undefined);
    const url = result?.result?.value;
    if (typeof url === "string" && url !== "about:blank") return url;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Native CEF private page did not finish its initial navigation");
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Native CEF endpoint returned HTTP ${response.status} at ${url}`);
  return (await response.json()) as T;
}

function sendControlCommand(path: string, command: string) {
  return new Promise<string>((resolveResponse, reject) => {
    const socket = createConnection(path);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", reject);
    socket.once("close", () => resolveResponse(response.trim()));
    socket.once("connect", () => socket.end(`${command}\n`));
  });
}

async function resolveExecutable(explicit?: string) {
  const candidates = explicit
    ? [resolve(explicit)]
    : [
        join(process.cwd(), "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host"),
        join(process.cwd(), "native/cef-host/build/Release/ufo-cef-host.app/Contents/MacOS/ufo-cef-host"),
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known development location.
    }
  }
  throw new Error(`Native CEF executable not found. Run npm run native:cef:build or set executable explicitly.`);
}
