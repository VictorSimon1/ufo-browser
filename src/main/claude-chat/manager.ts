import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";

export type ChatEvent =
  | { type: "start"; messageId: string }
  | { type: "delta"; messageId: string; text: string }
  | { type: "tool"; messageId: string; name: string; detail?: string }
  | { type: "done"; messageId: string; sessionId?: string }
  | { type: "error"; messageId: string; error: string };

type ClaudeSessionOptions = {
  claudePath: string;
  workspace: string;
  cliDirectory: string;
  socketPath: string;
};

export class ClaudeSessionManager {
  private readonly listeners = new Set<(event: ChatEvent) => void>();
  private process?: ChildProcessWithoutNullStreams;
  private sessionId?: string;

  constructor(private readonly options: ClaudeSessionOptions) {}

  onEvent(listener: (event: ChatEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize() {
    await mkdir(this.options.workspace, { recursive: true, mode: 0o700 });
  }

  send(text: string) {
    if (this.process) throw new Error("Browser Agent is already running");
    const messageId = randomUUID();
    const nextSessionId = this.sessionId ?? randomUUID();
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "auto",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--allowed-tools",
      "Skill,Bash,Read,Write",
      "--append-system-prompt",
      SYSTEM_PROMPT,
      ...(this.sessionId
        ? ["--resume", this.sessionId]
        : ["--session-id", nextSessionId]),
      "--",
      text,
    ];
    const child = spawn(this.options.claudePath, args, {
      cwd: this.options.workspace,
      env: {
        ...process.env,
        PATH: `${this.options.cliDirectory}:${process.env.PATH || ""}`,
        X_BROWSER_SOCKET: this.options.socketPath,
        X_BROWSER_AGENT_WORKSPACE: this.options.workspace,
        X_BROWSER_NODE: process.execPath,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    this.process = child;
    this.emit({ type: "start", messageId });
    this.consume(child, messageId, nextSessionId);
    return { messageId };
  }

  stop() {
    this.process?.kill("SIGTERM");
  }

  private consume(
    child: ChildProcessWithoutNullStreams,
    messageId: string,
    fallbackSessionId: string,
  ) {
    const stdout = createInterface({ input: child.stdout });
    let stderr = "";
    let finished = false;
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8000);
    });
    stdout.on("line", (line) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.session_id) this.sessionId = event.session_id;
      const stream = event.type === "stream_event" ? event.event : undefined;
      if (stream?.type === "content_block_delta") {
        const text = stream.delta?.text;
        if (typeof text === "string" && text) {
          this.emit({ type: "delta", messageId, text });
        }
      }
      if (
        stream?.type === "content_block_start" &&
        stream.content_block?.type === "tool_use"
      ) {
        this.emit({
          type: "tool",
          messageId,
          name: stream.content_block.name || "Tool",
        });
      }
      if (event.type === "result") {
        finished = true;
        this.sessionId = event.session_id || this.sessionId || fallbackSessionId;
        this.emit({ type: "done", messageId, sessionId: this.sessionId });
      }
    });
    child.on("error", (error) => {
      finished = true;
      this.emit({ type: "error", messageId, error: error.message });
    });
    child.on("close", (code) => {
      this.process = undefined;
      stdout.close();
      if (!finished && code !== 0) {
        this.emit({
          type: "error",
          messageId,
          error: stderr.trim() || `Claude exited with code ${code}`,
        });
      } else if (!finished) {
        this.sessionId ??= fallbackSessionId;
        this.emit({ type: "done", messageId, sessionId: this.sessionId });
      }
    });
  }

  private emit(event: ChatEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

const SYSTEM_PROMPT = `You are the Browser Agent embedded in X-Browser. For every website interaction, use the bundled x-browser skill and the x-browser CLI available on PATH. Work in isolated Task Spaces and reuse the same numeric Space id across command rounds. Never launch Chrome, Playwright, Puppeteer, or another browser controller. Do not use OS-level mouse or keyboard automation. Browser control must flow through X-Browser's local socket, ownership, lease, and CDP bridge. Keep the user informed with concise results and preserve live pages only when useful.`;
