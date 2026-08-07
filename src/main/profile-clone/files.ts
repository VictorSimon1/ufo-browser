import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { CHROME_STORAGE_PATHS } from "../chrome-import/storage-preflight.js";

export async function copyProfileLoginStorage(
  sourceRoot: string,
  targetRoot: string,
) {
  const copied: string[] = [];
  await mkdir(targetRoot, { recursive: false, mode: 0o700 });
  await chmod(targetRoot, 0o700);
  for (const dataset of CHROME_STORAGE_PATHS) {
    const source = join(sourceRoot, dataset);
    const target = join(targetRoot, dataset);
    if (!(await pathExists(source))) continue;
    await copyTreeSafely(source, target);
    copied.push(dataset);
  }
  return copied;
}

async function copyTreeSafely(sourcePath: string, targetPath: string) {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await mkdir(targetPath, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
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

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
