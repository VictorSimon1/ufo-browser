import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveAgentSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  home = homedir(),
) {
  if (env.UFO_BROWSER_SOCKET) return env.UFO_BROWSER_SOCKET;
  if (env.X_BROWSER_SOCKET) return env.X_BROWSER_SOCKET;
  for (const marker of [
    join(cwd, ".ufo-browser-test/socket-path"),
    join(cwd, ".x-browser-test/socket-path"),
  ]) {
    if (!existsSync(marker)) continue;
    const candidate = readFileSync(marker, "utf8").trim();
    // A previous test run may leave its marker behind after the socket has
    // been removed. Never let that stale path shadow a live installed App.
    if (candidate && existsSync(candidate)) return candidate;
  }
  const primary = join(home, "Library/Application Support/UFO-Browser/ufo-browser.sock");
  const legacy = join(home, "Library/Application Support/X-Browser/x-browser.sock");
  return existsSync(primary) || !existsSync(legacy) ? primary : legacy;
}
