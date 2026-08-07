import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { isValidProfileId } from "./profile-registry.js";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = ["png", "jpg", "webp"] as const;

export class ProfileAvatarStore {
  constructor(private readonly root: string) {}

  async importFromPath(profileId: string, sourcePath: string | undefined) {
    if (!sourcePath) return false;
    const source = await safeAvatar(sourcePath);
    if (!source) return false;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await this.remove(profileId);
    const target = this.path(profileId, source.extension);
    const temporary = `${target}.${process.pid}.tmp`;
    await copyFile(sourcePath, temporary, fsConstants.COPYFILE_FICLONE);
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    return true;
  }

  async clone(sourceProfileId: string, targetProfileId: string) {
    for (const extension of EXTENSIONS) {
      const source = this.path(sourceProfileId, extension);
      try {
        if (await this.importFromPath(targetProfileId, source)) return true;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  async dataUrl(profileId: string) {
    for (const extension of EXTENSIONS) {
      try {
        const path = this.path(profileId, extension);
        const info = await lstat(path);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size <= 0 ||
          info.size > MAX_AVATAR_BYTES
        ) {
          continue;
        }
        const data = await readFile(path);
        const detected = detectAvatar(data);
        if (!detected) continue;
        return `data:${detected.mimeType};base64,${data.toString("base64")}`;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return undefined;
  }

  async remove(profileId: string) {
    for (const extension of EXTENSIONS) {
      await rm(this.path(profileId, extension), { force: true });
    }
  }

  private path(profileId: string, extension: (typeof EXTENSIONS)[number]) {
    if (!isValidProfileId(profileId)) throw new Error("invalid avatar profile id");
    return join(this.root, `${profileId}.${extension}`);
  }
}

export async function discoverChromeProfileAvatar(
  profilePath: string,
  profileInfo: unknown,
) {
  const info = profileInfo as { gaia_picture_file_name?: unknown } | undefined;
  const configured = String(info?.gaia_picture_file_name || "").trim();
  const candidates = [
    ...(configured && !configured.includes("/") && !configured.includes("\\")
      ? [configured]
      : []),
    "Google Profile Picture.png",
    "Profile Avatar.png",
  ];
  for (const name of [...new Set(candidates)]) {
    const path = join(profilePath, name);
    if (await safeAvatar(path)) return path;
  }
  return undefined;
}

async function safeAvatar(path: string) {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size <= 0 ||
      info.size > MAX_AVATAR_BYTES
    ) {
      return undefined;
    }
    const handle = await readFile(path);
    return detectAvatar(handle);
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "EACCES") return undefined;
    throw error;
  }
}

function detectAvatar(data: Buffer) {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return { extension: "png" as const, mimeType: "image/png" };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { extension: "jpg" as const, mimeType: "image/jpeg" };
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: "webp" as const, mimeType: "image/webp" };
  }
  return undefined;
}
