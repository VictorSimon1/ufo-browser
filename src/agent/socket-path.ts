import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export type SocketPathOptions = {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
};

export function resolveSocketCandidates(
  options: SocketPathOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const explicit = env.UFO_BROWSER_SOCKET || env.X_BROWSER_SOCKET;
  if (explicit) return [explicit];

  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const candidates: string[] = [];
  for (const marker of [
    join(cwd, ".ufo-browser-test/socket-path"),
    join(cwd, ".x-browser-test/socket-path"),
  ]) {
    if (!existsSync(marker)) continue;
    const markedPath = readFileSync(marker, "utf8").trim();
    if (markedPath) candidates.push(markedPath);
  }

  candidates.push(
    join(home, "Library/Application Support/UFO-Browser/ufo-browser.sock"),
    join(home, "Library/Application Support/X-Browser/x-browser.sock"),
  );
  return [...new Set(candidates)];
}

export async function connectAgentSocket(
  candidates: string[],
): Promise<{ path: string; socket: Socket }> {
  let lastError: unknown;
  for (const path of candidates) {
    try {
      return { path, socket: await connect(path) };
    } catch (error) {
      lastError = error;
    }
  }
  const tried = candidates.map((path) => JSON.stringify(path)).join(", ");
  const detail =
    lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Unable to connect to UFO-Browser; tried ${tried}${detail}`);
}

function connect(path: string) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(path);
    const onError = (error: Error) => {
      socket.removeListener("connect", onConnect);
      socket.destroy();
      reject(error);
    };
    const onConnect = () => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}
