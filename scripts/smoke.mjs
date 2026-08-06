import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

const release = join(process.cwd(), "release");
const directories = await readdir(release, { withFileTypes: true });
let app;
for (const directory of directories) {
  if (!directory.isDirectory() || !directory.name.startsWith("mac")) continue;
  const candidate = join(release, directory.name, "UFO-Browser.app");
  try {
    await access(candidate);
    app = candidate;
    break;
  } catch {
    // Keep looking through architecture-specific output directories.
  }
}
if (!app) throw new Error("release does not contain UFO-Browser.app");
await access(join(app, "Contents/MacOS/UFO-Browser"));
await access(join(app, "Contents/Resources/app.asar"));
await access(join(app, "Contents/Resources/icon.icns"));
await access(join(app, "Contents/Resources/icon.png"));
await access(join(app, "Contents/Resources/skills/ufo-browser/SKILL.md"));
console.log(`smoke ok: ${app}`);
