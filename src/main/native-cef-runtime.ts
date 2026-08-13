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
  useMockKeychain?: boolean;
  overview?: boolean;
  env?: NodeJS.ProcessEnv;
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

export class NativeCefRuntime {
  private process?: ChildProcess;
  private readonly connections = new Set<NativeCdpConnection>();
  private port?: number;
  private versionInfo?: NativeCefVersion;
  private controlSocketPath?: string;

  constructor(private readonly defaults: NativeCefRuntimeOptions = {}) {}

  isRunning() {
    return Boolean(this.process && !this.process.killed);
  }

  getPort() {
    return this.port;
  }

  async start(options: NativeCefRuntimeOptions = {}) {
    if (this.isRunning()) return this.version();
    if (process.platform !== "darwin") throw new Error("Native CEF currently supports macOS only");
    const merged = { ...this.defaults, ...options };
    const port = merged.port ?? 9222;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`Invalid Native CEF DevTools port: ${port}`);
    }
    const executable = await resolveExecutable(merged.executable);
    this.port = port;
    this.controlSocketPath = merged.controlSocket ? resolve(merged.controlSocket) : undefined;
    const args = [
      `--url=${merged.url || "https://www.google.com/"}`,
      `--agent-devtools-port=${port}`,
    ];
    if (merged.userDataDir) args.push(`--user-data-dir=${resolve(merged.userDataDir)}`);
    if (merged.controlSocket) args.push(`--control-socket=${resolve(merged.controlSocket)}`);
    if (merged.useMockKeychain) args.push("--use-mock-keychain");
    if (merged.overview) args.push("--overview");
    this.process = spawn(executable, args, {
      cwd: merged.cwd,
      env: { ...process.env, ...merged.env },
      stdio: "ignore",
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
    if (!this.port) throw new Error("Native CEF runtime is not started");
    if (this.versionInfo) return this.versionInfo;
    this.versionInfo = await fetchJson<NativeCefVersion>(this.endpoint("/json/version"));
    return this.versionInfo;
  }

  async targets() {
    if (!this.port) throw new Error("Native CEF runtime is not started");
    return fetchJson<NativeCefTarget[]>(this.endpoint("/json/list"));
  }

  async connect(targetId?: string) {
    const targets = await this.targets();
    const target = targetId
      ? targets.find((candidate) => candidate.id === targetId)
      : targets.find((candidate) => candidate.type === "page");
    if (!target?.webSocketDebuggerUrl) throw new Error(`Native CEF target not found: ${targetId || "page"}`);
    const connection = new NativeCdpConnection(target.webSocketDebuggerUrl);
    this.connections.add(connection);
    return connection;
  }

  async connectBrowser() {
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
    if (!child || child.killed) return;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveStop();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
      child.kill("SIGTERM");
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

  private endpoint(path: string) {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  private async waitForVersion(timeoutMs: number) {
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
