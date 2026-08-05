import { access } from "node:fs/promises";
import { join } from "node:path";

const app = join(process.cwd(), "release/mac-arm64/X-Browser.app");
await access(join(app, "Contents/MacOS/X-Browser"));
await access(join(app, "Contents/Resources/app.asar"));
console.log(`smoke ok: ${app}`);
