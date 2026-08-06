// @ts-nocheck
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SRC_DIR, "..");

export function agentWorkspace() {
  if (process.env.UFO_BROWSER_AGENT_WORKSPACE) {
    return resolvePath(process.env.UFO_BROWSER_AGENT_WORKSPACE);
  }
  if (process.env.X_BROWSER_AGENT_WORKSPACE) {
    return resolvePath(process.env.X_BROWSER_AGENT_WORKSPACE);
  }
  if (process.env.EGO_BROWSER_AGENT_WORKSPACE) {
    return resolvePath(process.env.EGO_BROWSER_AGENT_WORKSPACE);
  }

  const candidates = [
    resolve(process.cwd(), "skills", "ufo-browser"),
    resolve(REPO_ROOT, "..", "skills", "ufo-browser"),
    resolve(REPO_ROOT, "..", "..", "skills", "ufo-browser"),
    resolve(process.cwd(), "skills", "x-browser"),
    resolve(REPO_ROOT, "..", "skills", "x-browser"),
    resolve(REPO_ROOT, "..", "..", "skills", "x-browser"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

export function resolvePath(path) {
  if (path.startsWith("~")) {
    return resolve(process.env.HOME || process.env.USERPROFILE || ".", path.slice(1));
  }
  return resolve(path);
}

export function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadEnv() {
  loadEnvFile(resolve(REPO_ROOT, ".env"));
  loadEnvFile(resolve(agentWorkspace(), ".env"));
}
