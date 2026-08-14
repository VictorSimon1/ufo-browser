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
  private readonly connections = new Set<NativeCdpConnection>();
  private port?: number;
  private versionInfo?: NativeCefVersion;
  private controlSocketPath?: string;
  private devtoolsSocketPath?: string;

  constructor(private readonly defaults: NativeCefRuntimeOptions = {}) {}

  isRunning() {
    return Boolean(this.process && this.process.exitCode === null && !this.process.killed);
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
      stdio: "ignore",
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
    if (!child || child.killed) return;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
        resolveStop();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
      signalProcessGroup(child, "SIGTERM");
    });
  }

  async control(command: "show" | "hide" | "focus" | "close" | "status" | "agent-active-on" | "agent-active-off") {
    const path = this.controlSocketPath || this.defaults.controlSocket;
    if (!path) throw new Error("Native CEF control socket is not configured");
    const deadline = Date.now() + 5_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await sendControlCommand(path, command);
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
