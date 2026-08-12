import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_NAME = "ufo-browser";
export const MANAGED_MARKER = ".ufo-browser-managed.json";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path, home) {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

async function commandExists(command, env = process.env) {
  const entries = String(env.PATH || "")
    .split(delimiter)
    .filter(Boolean);
  for (const entry of entries) {
    try {
      await access(join(entry, command), constants.X_OK);
      return true;
    } catch {
      // Continue through PATH.
    }
  }
  return false;
}

export function defaultAgentTargets({
  home = homedir(),
  env = process.env,
} = {}) {
  const codexHome = resolve(
    expandHome(env.CODEX_HOME || join(home, ".codex"), home),
  );
  const targets = [
    {
      id: "claude",
      label: "Claude Code",
      baseDir: join(home, ".claude"),
      command: "claude",
    },
    {
      id: "codex",
      label: "Codex",
      baseDir: codexHome,
      command: "codex",
      explicit: Boolean(env.CODEX_HOME),
    },
    {
      id: "cursor",
      label: "Cursor",
      baseDir: join(home, ".cursor"),
      command: "cursor",
      appPaths: [
        "/Applications/Cursor.app",
        join(home, "Applications/Cursor.app"),
      ],
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      baseDir: join(home, ".gemini"),
      command: "gemini",
    },
    {
      id: "copilot",
      label: "GitHub Copilot CLI",
      baseDir: join(home, ".copilot"),
      command: "copilot",
    },
    {
      id: "opencode",
      label: "OpenCode",
      baseDir: join(home, ".config/opencode"),
      command: "opencode",
    },
    {
      id: "agents",
      label: "Agent Skills standard",
      baseDir: join(home, ".agents"),
    },
  ];

  const extraRoots = String(env.UFO_BROWSER_EXTRA_SKILL_ROOTS || "")
    .split(delimiter)
    .map((path) => path.trim())
    .filter(Boolean);
  for (const [index, skillsRoot] of extraRoots.entries()) {
    targets.push({
      id: `custom-${index + 1}`,
      label: `Custom Agent ${index + 1}`,
      skillsRoot: resolve(expandHome(skillsRoot, home)),
      explicit: true,
    });
  }

  const seen = new Set();
  return targets
    .map((target) => ({
      ...target,
      baseDir: target.baseDir ? resolve(target.baseDir) : undefined,
      skillsRoot: resolve(
        target.skillsRoot || join(target.baseDir, "skills"),
      ),
    }))
    .filter((target) => {
      if (seen.has(target.skillsRoot)) return false;
      seen.add(target.skillsRoot);
      return true;
    });
}

async function isAgentInstalled(target) {
  if (target.explicit) return true;
  if (target.baseDir && (await pathExists(target.baseDir))) return true;
  if (target.command && (await commandExists(target.command))) return true;
  for (const appPath of target.appPaths || []) {
    if (await pathExists(appPath)) return true;
  }
  return false;
}

async function directoryFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".DS_Store" || entry.name === MANAGED_MARKER) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await directoryFiles(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function hashSkillDirectory(sourceRoot) {
  const hash = createHash("sha256");
  const files = await directoryFiles(sourceRoot);
  for (const path of files) {
    hash.update(path.slice(sourceRoot.length + 1));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function validateSkillSource(sourceRoot) {
  const skillFile = join(sourceRoot, "SKILL.md");
  const agentManifest = join(sourceRoot, "agents/openai.yaml");
  const contents = await readFile(skillFile, "utf8");
  if (!/^---\s*[\s\S]*?^name:\s*ufo-browser\s*$/m.test(contents)) {
    throw new Error(`Invalid UFO-Browser Skill frontmatter: ${skillFile}`);
  }
  await access(agentManifest);
}

async function readManagedMarker(targetRoot) {
  try {
    return JSON.parse(await readFile(join(targetRoot, MANAGED_MARKER), "utf8"));
  } catch {
    return null;
  }
}

function assertSafeTarget(skillsRoot, targetRoot) {
  if (
    basename(targetRoot) !== SKILL_NAME ||
    dirname(targetRoot) !== resolve(skillsRoot)
  ) {
    throw new Error(`Refusing unsafe Skill target: ${targetRoot}`);
  }
}

export async function syncSkillToTarget({
  sourceRoot,
  sourceHash,
  target,
  dryRun = false,
  force = false,
}) {
  if (!(await isAgentInstalled(target))) {
    return { ...target, status: "skipped", reason: "not-installed" };
  }

  const skillsRoot = resolve(target.skillsRoot);
  const targetRoot = join(skillsRoot, SKILL_NAME);
  assertSafeTarget(skillsRoot, targetRoot);
  const targetState = await lstat(targetRoot).catch(() => null);
  const marker = targetState ? await readManagedMarker(targetRoot) : null;
  const isManaged =
    marker?.managedBy === "UFO-Browser" && marker?.skill === SKILL_NAME;
  if (targetState && !isManaged && !force) {
    return {
      ...target,
      targetRoot,
      status: "skipped",
      reason: "unmanaged-target",
    };
  }
  if (isManaged && !force) {
    const targetHash = await hashSkillDirectory(targetRoot);
    if (targetHash === sourceHash) {
      return {
        ...target,
        targetRoot,
        status: "current",
        sourceHash,
      };
    }
  }

  if (dryRun) {
    return {
      ...target,
      targetRoot,
      status: "planned",
      sourceHash,
    };
  }

  await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${Date.now()}`;
  const temporaryRoot = join(skillsRoot, `.${SKILL_NAME}.install-${token}`);
  const backupRoot = join(skillsRoot, `.${SKILL_NAME}.backup-${token}`);
  assertSafeTarget(skillsRoot, targetRoot);
  await rm(temporaryRoot, { recursive: true, force: true });
  await cp(sourceRoot, temporaryRoot, { recursive: true, force: true });
  await writeFile(
    join(temporaryRoot, MANAGED_MARKER),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        managedBy: "UFO-Browser",
        skill: SKILL_NAME,
        sourceHash,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  let backedUp = false;
  try {
    if (targetState) {
      await rename(targetRoot, backupRoot);
      backedUp = true;
    }
    await rename(temporaryRoot, targetRoot);
    if (backedUp) await rm(backupRoot, { recursive: true, force: true });
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    if (backedUp && !(await pathExists(targetRoot))) {
      await rename(backupRoot, targetRoot).catch(() => {});
    }
    throw error;
  }

  return {
    ...target,
    targetRoot,
    status: targetState ? "updated" : "installed",
    sourceHash,
  };
}

export async function syncAgentSkills({
  sourceRoot = resolve(process.cwd(), "skills", SKILL_NAME),
  targets = defaultAgentTargets(),
  dryRun = false,
  force = false,
} = {}) {
  await validateSkillSource(sourceRoot);
  const sourceHash = await hashSkillDirectory(sourceRoot);
  const results = [];
  for (const target of targets) {
    try {
      results.push(
        await syncSkillToTarget({
          sourceRoot,
          sourceHash,
          target,
          dryRun,
          force,
        }),
      );
    } catch (error) {
      results.push({
        ...target,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { sourceRoot, sourceHash, results };
}

function printSummary(summary, { dryRun }) {
  console.log(`UFO-Browser Skill: ${summary.sourceRoot}`);
  console.log(`SHA-256: ${summary.sourceHash}`);
  for (const result of summary.results) {
    if (["installed", "updated", "planned"].includes(result.status)) {
      const action = dryRun ? "would update" : result.status;
      console.log(`  ✓ ${result.label}: ${action} -> ${result.targetRoot}`);
      continue;
    }
    if (result.status === "current") {
      console.log(`  ✓ ${result.label}: current -> ${result.targetRoot}`);
      continue;
    }
    if (result.status === "error") {
      console.error(`  ✗ ${result.label}: ${result.reason}`);
      continue;
    }
    const reason =
      result.reason === "unmanaged-target"
        ? "existing folder is not managed by UFO-Browser"
        : "agent not installed";
    console.log(`  - ${result.label}: skipped (${reason})`);
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const sourceIndex = process.argv.indexOf("--source");
  const sourceArgument = sourceIndex === -1 ? undefined : process.argv[sourceIndex + 1];
  if (sourceIndex !== -1 && (!sourceArgument || sourceArgument.startsWith("--"))) {
    throw new Error("--source requires a Skill directory path");
  }
  const sourceRoot = resolve(
    sourceArgument ||
      process.env.UFO_BROWSER_SKILL_SOURCE_ROOT ||
      join(process.cwd(), "skills", SKILL_NAME),
  );
  const summary = await syncAgentSkills({ sourceRoot, dryRun, force });
  printSummary(summary, { dryRun });
  if (summary.results.some((result) => result.status === "error")) {
    process.exitCode = 1;
  }
}
