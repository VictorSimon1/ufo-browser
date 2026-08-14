import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const source = await readFile(join(root, "native/cef-host/main_mac.mm"), "utf8");

assert.match(source, /IsNativeTitlebarPoint\(NSWindow\* window/);
assert.match(source, /IsTitlebarDragEvent\(NSEvent\* event/);
assert.match(source, /g_titlebar_drag_window/);
assert.match(source, /if \(IsTitlebarDragEvent\(event\)\) \{\s*\[super sendEvent:event\];/s);
assert.doesNotMatch(source, /if \(humanInput\) return;/);

console.log(JSON.stringify({ nativeTitlebarDrag: true, pageInputStillBlocked: true }));
