import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CHROME_STORAGE_PATHS } from "../chrome-import/storage-preflight.js";

const DATASETS = new Set<string>(CHROME_STORAGE_PATHS);

export async function replaceProfileStorageDataset(options: {
  sourceRoot: string;
  targetRoot: string;
  workRoot: string;
  dataset: string;
  sourcePresent: boolean;
  beforePublish?: () => void | Promise<void>;
}) {
  if (!DATASETS.has(options.dataset)) {
    throw new Error("invalid Profile storage dataset");
  }
  const source = safeDatasetPath(options.sourceRoot, options.dataset);
  const target = safeDatasetPath(options.targetRoot, options.dataset);
  const operationRoot = join(
    options.workRoot,
    options.dataset.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  const staging = join(operationRoot, "incoming");
  const backup = join(operationRoot, "backup");
  await mkdir(operationRoot, { recursive: true, mode: 0o700 });
  await recoverReplacement(target, staging, backup);

  if (options.sourcePresent) {
    await copyTreeSafely(source, staging);
  }
  const targetPresent = await pathExists(target);
  if (targetPresent) await rename(target, backup);
  try {
    if (options.sourcePresent) {
      await options.beforePublish?.();
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(staging, target);
    }
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (!(await pathExists(target)) && (await pathExists(backup))) {
      await rename(backup, target).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function recoverReplacement(
  target: string,
  staging: string,
  backup: string,
) {
  if (await pathExists(backup)) {
    if (await pathExists(target)) {
      await rm(backup, { recursive: true, force: true });
    } else {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(backup, target);
    }
  }
  await rm(staging, { recursive: true, force: true });
}

async function copyTreeSafely(sourcePath: string, targetPath: string) {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await mkdir(targetPath, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || volatileStorageFile(entry.name)) continue;
      await copyTreeSafely(
        join(sourcePath, entry.name),
        join(targetPath, entry.name),
      );
    }
    await chmod(targetPath, 0o700);
    return;
  }
  if (!info.isFile()) return;
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE);
  await chmod(targetPath, 0o600);
}

function volatileStorageFile(name: string) {
  return (
    name === "LOCK" ||
    name === "LOG" ||
    name === "LOG.old" ||
    name === "QuotaManager-journal" ||
    name === "QuotaManager-wal" ||
    name === "QuotaManager-shm" ||
    name.endsWith(".tmp")
  );
}

function safeDatasetPath(root: string, dataset: string) {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, dataset);
  const child = relative(resolvedRoot, path);
  if (child !== dataset || child.includes(sep)) {
    throw new Error("Profile storage dataset escaped its root");
  }
  return path;
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
