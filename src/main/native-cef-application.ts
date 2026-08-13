import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

export type NativeCefApplicationOptions = {
  agentScript?: string;
  cefExecutable?: string;
  userDataDir?: string;
  infoFile?: string;
  overviewDevtoolsPort?: number;
  useMockKeychain?: boolean;
  startupTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Electron-free UFO-Browser product coordinator.
 *
 * The Agent service owns Task Spaces and the HTTP Overview API. A native CEF
 * host renders that API with CEF's Chrome Runtime, while Space hosts remain
 * isolated runtimes managed by the Agent. Keeping the two processes explicit
 * gives us a safe shutdown boundary and makes the eventual .app launcher
 * independent of Electron.
 */
export class NativeCefApplication {
  private agent?: ChildProcess;
  private overview?: ChildProcess;
  private infoPath?: string;
  private overviewPort?: number;
  private stopPromise?: Promise<void>;
  private stopping = false;

  constructor(private readonly defaults: NativeCefApplicationOptions = {}) {}

  isRunning() {
    return Boolean(this.agent && !this.agent.killed && this.overview && !this.overview.killed);
  }

  async start(options: NativeCefApplicationOptions = {}) {
    if (this.isRunning()) return this.status();
    if (process.platform !== "darwin") throw new Error("Native CEF currently supports macOS only");
    const merged = { ...this.defaults, ...options };
    const bundleRoot = process.env.UFO_BROWSER_NATIVE_WORKING_DIR;
    const userDataDir = resolve(merged.userDataDir || join(homedir(), "Library/Application Support/UFO-Browser"));
    await mkdir(userDataDir, { recursive: true, mode: 0o700 });
    const infoFile = resolve(merged.infoFile || join(userDataDir, "overview.json"));
    await rm(infoFile, { force: true });
    const agentScript = resolve(merged.agentScript || process.env.UFO_BROWSER_NATIVE_AGENT_SCRIPT || join(bundleRoot || process.cwd(), bundleRoot ? "Contents/Resources/native-cef-agent.js" : "dist/main/native-cef-agent.js"));
    const cefExecutable = resolve(merged.cefExecutable || resolveCefExecutable());
    const socketPath = join(userDataDir, "ufo-browser.sock");
    const overviewControlSocket = merged.env?.UFO_BROWSER_OVERVIEW_CONTROL_SOCKET || join(process.env.TMPDIR || "/tmp", `ufo-browser-overview-${process.pid}.sock`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...merged.env,
      UFO_BROWSER_NATIVE_USER_DATA: userDataDir,
      UFO_BROWSER_SOCKET: socketPath,
      UFO_BROWSER_NATIVE_OVERVIEW_MODE: "external",
      UFO_BROWSER_OVERVIEW_INFO_FILE: infoFile,
      UFO_CEF_HOST: cefExecutable,
      UFO_BROWSER_OVERVIEW_CONTROL_SOCKET: overviewControlSocket,
      UFO_BROWSER_NATIVE_KEYCHAIN_HELPER: merged.env?.UFO_BROWSER_NATIVE_KEYCHAIN_HELPER || process.env.UFO_BROWSER_NATIVE_KEYCHAIN_HELPER || join(bundleRoot || process.cwd(), bundleRoot ? "Contents/Resources/ufo-keychain-helper" : "dist/bin/ufo-keychain-helper"),
      UFO_BROWSER_NATIVE_WORKING_DIR: bundleRoot || "",
      // Native Application owns the production default. Keep the private CEF
      // bridge explicit when spawning the standalone Agent so a DMG launch or
      // a test runner with a sanitized environment cannot silently fall back
      // to the legacy public DevTools port.
      UFO_CEF_PRIVATE_BRIDGE: merged.env?.UFO_CEF_PRIVATE_BRIDGE ||
        process.env.UFO_CEF_PRIVATE_BRIDGE || "1",
      ...(merged.useMockKeychain ? { UFO_CEF_USE_MOCK_KEYCHAIN: "1" } : {}),
    };
    this.infoPath = infoFile;
    this.agent = spawn(process.execPath, [agentScript], { cwd: bundleRoot || process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    this.agent.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    this.agent.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    this.agent.once("exit", () => {
      this.agent = undefined;
      if (!this.stopping) void this.stop();
    });
    const info = await waitForOverviewInfo(infoFile, merged.startupTimeoutMs ?? 15_000, this.agent);
    const port = merged.overviewDevtoolsPort ?? await findFreePort();
    this.overviewPort = port;
    this.overview = spawn(cefExecutable, [
      `--url=${info.url}`,
      "--overview",
      `--agent-devtools-port=${port}`,
      `--control-socket=${overviewControlSocket}`,
      `--user-data-dir=${join(userDataDir, "OverviewWindow")}`,
      ...(merged.useMockKeychain ? ["--use-mock-keychain"] : []),
    ], { cwd: bundleRoot || process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    this.overview.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    this.overview.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    this.overview.once("exit", () => {
      this.overview = undefined;
      if (!this.stopping) void this.stop();
    });
    await waitForDevtools(port, merged.startupTimeoutMs ?? 15_000, this.overview);
    return this.status();
  }

  status() {
    return {
      running: this.isRunning(),
      overviewUrl: this.infoPath,
      overviewDevtoolsPort: this.overviewPort,
      agentPid: this.agent?.pid,
      overviewPid: this.overview?.pid,
    };
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopping = true;
      const overview = this.overview;
      const agent = this.agent;
      this.overview = undefined;
      this.agent = undefined;
      await terminate(overview);
      await terminate(agent);
      if (this.infoPath) await rm(this.infoPath, { force: true }).catch(() => undefined);
      this.infoPath = undefined;
      this.overviewPort = undefined;
      this.stopping = false;
      this.stopPromise = undefined;
    })();
    return this.stopPromise;
  }
}

async function waitForOverviewInfo(path: string, timeoutMs: number, child: ChildProcess) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Native CEF Agent exited before Overview started (${child.exitCode})`);
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (typeof value?.url === "string" && value.url.startsWith("http://127.0.0.1:")) return value as { url: string };
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Native CEF Overview API did not become ready: ${String(lastError || "timeout")}`);
}

async function waitForDevtools(port: number, timeoutMs: number, child: ChildProcess) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Native CEF Overview host exited (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Native CEF Overview host did not become ready: ${String(lastError || "timeout")}`);
}

async function terminate(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolveDone) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolveDone();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveDone();
    });
    child.kill("SIGTERM");
  });
}

async function findFreePort() {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (!port) throw new Error("unable to allocate Native CEF application port");
  return port;
}

function resolveCefExecutable() {
  const bundleRoot = process.env.UFO_BROWSER_NATIVE_WORKING_DIR;
  if (bundleRoot) return join(bundleRoot, "Contents/MacOS/ufo-cef-host");
  const candidates = [
    join(process.cwd(), "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host"),
    join(process.cwd(), "native/cef-host/build/Release/ufo-cef-host.app/Contents/MacOS/ufo-cef-host"),
  ];
  return candidates.find((candidate) => {
    try { return existsSync(candidate); } catch { return false; }
  }) || candidates[0];
}

function delay(ms: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

// Normalize aliases such as macOS /tmp -> /private/tmp before deciding if
// this module is the executable entry point. Without this, a relocated .app
// can exit cleanly because Node sees two different spellings of the same file.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const application = new NativeCefApplication({
    useMockKeychain: process.env.UFO_CEF_USE_MOCK_KEYCHAIN === "1",
    userDataDir: process.env.UFO_BROWSER_NATIVE_USER_DATA,
    cefExecutable: process.env.UFO_CEF_HOST,
    agentScript: process.env.UFO_BROWSER_NATIVE_AGENT_SCRIPT,
  });
  await application.start();
  const shutdown = () => void application.stop().finally(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.error(`[UFO Native CEF] Application running: ${JSON.stringify(application.status())}`);
}
