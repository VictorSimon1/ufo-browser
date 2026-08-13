import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { CHROME_STORAGE_PATHS } from "./chrome-import/storage-preflight.js";

const PROFILE_SEED_VERSION = 1;
const ROOT_FILES = ["Local State", "Preferences", "Secure Preferences"] as const;
const COOKIE_FILES = ["Cookies", join("Network", "Cookies")] as const;
const SEED_PATHS = [...ROOT_FILES, ...COOKIE_FILES, ...CHROME_STORAGE_PATHS];

type SeedMarker = {
  version: 1;
  sourceProfileId: string;
  sourcePartition: string;
  seededAt: number;
};

/**
 * Seed a fresh CEF user-data directory from an existing UFO/Chromium Profile.
 *
 * This intentionally copies only browser login/storage datasets. Password
 * databases, history, downloads, extensions, and lock files are never copied.
 * A marker makes the operation one-shot per native Space so an active CEF
 * profile is never overwritten underneath a running renderer.
 */
export async function seedNativeCefProfile(options: {
  sourceRoot?: string;
  targetRoot: string;
  sourceProfileId: string;
}) {
  const targetRoot = options.targetRoot;
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await chmod(targetRoot, 0o700);
  const markerPath = join(targetRoot, ".ufo-profile-seed.json");
  if (await isFile(markerPath)) return { seeded: false, reason: "already-seeded" as const };
  if (!options.sourceRoot) {
    await writeMarker(markerPath, {
      version: PROFILE_SEED_VERSION,
      sourceProfileId: options.sourceProfileId,
      sourcePartition: "",
      seededAt: Date.now(),
    });
    return { seeded: false, reason: "source-unavailable" as const };
  }
  const sourceRoot = options.sourceRoot;
  for (const relativePath of SEED_PATHS) {
    const source = join(sourceRoot, relativePath);
    if (!(await pathExists(source))) continue;
    await copyTreeSafely(source, join(targetRoot, relativePath));
  }
  await writeMarker(markerPath, {
    version: PROFILE_SEED_VERSION,
    sourceProfileId: options.sourceProfileId,
    sourcePartition: sourceRoot,
    seededAt: Date.now(),
  });
  return { seeded: true, reason: "copied" as const };
}

async function copyTreeSafely(sourcePath: string, targetPath: string) {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await mkdir(targetPath, { recursive: true, mode: 0o700 });
    await chmod(targetPath, 0o700);
    // Avoid copying Chromium lock/socket files if a source profile was left
    // open. They are process-local and can make the destination unusable.
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || isLockName(entry.name)) continue;
      await copyTreeSafely(join(sourcePath, entry.name), join(targetPath, entry.name));
    }
    return;
  }
  if (!info.isFile() || isLockName(sourcePath.split("/").at(-1) || "")) return;
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  await copyFile(
    sourcePath,
    targetPath,
    fsConstants.COPYFILE_FICLONE,
  );
  await chmod(targetPath, 0o600);
}

function isLockName(name: string) {
  return name === "SingletonCookie" || name === "SingletonLock" || name === "SingletonSocket" ||
    name.endsWith(".lock") || name.endsWith(".socket");
}

async function writeMarker(path: string, marker: SeedMarker) {
  await writeFile(path, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function isFile(path: string) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readNativeCefProfileSeedMarker(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SeedMarker;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}
