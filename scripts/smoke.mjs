import { access } from "node:fs/promises";
import { join } from "node:path";

const app = join(process.cwd(), "release/mac-arm64/UFO-Browser.app");
await access(join(app, "Contents/MacOS/UFO-Browser"));
await access(join(app, "Contents/Resources/app.asar"));
console.log(`smoke ok: ${app}`);
