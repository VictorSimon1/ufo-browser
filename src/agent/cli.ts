import { createConnection, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertEgoCreateTabUrl,
  createEgoCompatibilityContext,
  formatCliLogValue,
  installEgoCompatibilityGlobals,
} from "./compat.js";
import * as runtime from "./runtime/helpers.js";

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

class AgentHost {
  onCDPMessage?: (payload: string) => void;
  onSendCDPMessageError?: (message: string, errorCode?: string) => void;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.receive(String(chunk)));
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("EGO_TASK_HOST_DISCONNECTED"));
      }
      this.pending.clear();
    });
  }

  listTaskSpaces = () => this.rpc("listTaskSpaces");
  listProfiles = () => this.rpc("listProfiles");
  createTaskSpace = (name: string, profileId?: string) =>
    this.rpc("createTaskSpace", name, profileId);
  claimTaskSpace = (id: number, name?: string) =>
    this.rpc("claimTaskSpace", id, name);
  useTaskSpace = (id: number) => this.rpc("useTaskSpace", id);
  closeTaskSpace = () => this.rpc("closeTaskSpace");
  createTab = (url?: string) => {
    assertEgoCreateTabUrl(url);
    return this.rpc("createTab", url);
  };
  listTabs = () => this.rpc("listTabs");
  snapshot = (options?: unknown) => this.rpc("snapshot", options);
  resolveRef = (refId: number) => this.rpc("resolveRef", refId);
  handOffTaskSpace = () => this.rpc("handOffTaskSpace");
  takeOverTaskSpace = () => this.rpc("takeOverTaskSpace");
  completeTaskSpace = () => this.rpc("completeTaskSpace");
  markTaskSpaceError = () => this.rpc("markTaskSpaceError");
  setAgentTaskState = (state: unknown) => this.rpc("setAgentTaskState", state);
  animationHighlightMouseToPosition = (...args: unknown[]) =>
    this.rpc("animationHighlightMouseToPosition", ...args);
  getBrowserVersion = () => this.rpc("getBrowserVersion");

  sendCDPMessage = (payload: string) => {
    this.write({ type: "cdp-send", payload });
  };

  close() {
    this.socket.end();
  }

  private rpc(method: string, ...args: unknown[]) {
    const id = this.nextId++;
    this.write({ type: "rpc", id, method, args });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.type === "rpc-result" || message.type === "rpc-error") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.type === "rpc-result") pending.resolve(message.result);
        else {
          const error: any = new Error(message.error);
          error.error_code = message.error_code;
          pending.reject(error);
        }
      } else if (message.type === "cdp-message") {
        this.onCDPMessage?.(message.payload);
      } else if (message.type === "cdp-error") {
        this.onSendCDPMessageError?.(message.error, message.error_code);
      }
    }
  }

  private write(message: unknown) {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }
}

const socketPath = resolveSocketPath();
const socket = await connect(socketPath);
const host = new AgentHost(socket);
(globalThis as any).ego = host;

try {
  process.exitCode = await runCompatibleMain(runtime);
} catch (error: any) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
} finally {
  host.close();
}

async function runCompatibleMain(harness: Record<string, any>) {
  const argv = process.argv.slice(2).filter((arg: string) => arg !== "nodejs");
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(
      "ufo-browser nodejs <<'EOF'\nconst task = await useOrCreateTaskSpace('task')\ncliLog(task)\nEOF\n",
    );
    return 0;
  }
  if (argv.length > 0) {
    process.stderr.write("Usage: ufo-browser nodejs <<'EOF' ... EOF\n");
    return 2;
  }
  const code = await readStdin();
  if (!code.trim()) {
    process.stderr.write("Usage: ufo-browser nodejs <<'EOF' ... EOF\n");
    return 2;
  }
  const directLog = (...values: unknown[]) => consoleOutput(...values);
  console.log = directLog;
  const extra =
    typeof harness.loadAgentHelpers === "function"
      ? await harness.loadAgentHelpers()
      : {};
  const modern = harness.helperContext(extra);
  const context = createEgoCompatibilityContext(
    modern,
    harness,
    directLog,
    host,
  );
  installEgoCompatibilityGlobals(globalThis, context);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  // Ego installs helpers as globals instead of declaring one function
  // parameter per helper. Matching that execution model lets ordinary scripts
  // shadow names such as `screenshot` or `count` with local const bindings,
  // while the unshadowed helper identifiers remain directly callable.
  const fn = new AsyncFunction(`"use strict";\n${code}`);
  await fn();
  if (typeof harness.stopScreencast === "function") {
    await harness.stopScreencast();
  }
  return 0;
}

function readStdin() {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function consoleOutput(...values: unknown[]) {
  process.stdout.write(`${values.map(formatCliLogValue).join(" ")}\n`);
}

function resolveSocketPath() {
  if (process.env.UFO_BROWSER_SOCKET) return process.env.UFO_BROWSER_SOCKET;
  if (process.env.X_BROWSER_SOCKET) return process.env.X_BROWSER_SOCKET;
  for (const marker of [
    join(process.cwd(), ".ufo-browser-test/socket-path"),
    join(process.cwd(), ".x-browser-test/socket-path"),
  ]) {
    if (existsSync(marker)) return readFileSync(marker, "utf8").trim();
  }
  const primary = join(
    homedir(),
    "Library/Application Support/UFO-Browser/ufo-browser.sock",
  );
  const legacy = join(
    homedir(),
    "Library/Application Support/X-Browser/x-browser.sock",
  );
  return existsSync(primary) || !existsSync(legacy) ? primary : legacy;
}

function connect(path: string) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
