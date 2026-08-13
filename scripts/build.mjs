import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const shared = {
  bundle: true,
  sourcemap: true,
  target: "node22",
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: ["src/electron.ts"],
  outfile: "dist/main/electron.js",
  platform: "node",
  format: "esm",
  external: ["electron"],
});

await build({
  ...shared,
  entryPoints: ["src/main/chrome-import/cookie-worker.ts"],
  outfile: "dist/main/chrome-cookie-worker.js",
  platform: "node",
  format: "esm",
});

await build({
  ...shared,
  entryPoints: [
    "src/main/chrome-import/storage-preflight-worker-entry.ts",
  ],
  outfile: "dist/main/chrome-storage-preflight-worker.js",
  platform: "node",
  format: "esm",
});

await build({
  ...shared,
  entryPoints: ["src/main/profile-sync/cookie-diff-worker.ts"],
  outfile: "dist/main/profile-sync-cookie-diff-worker.js",
  platform: "node",
  format: "esm",
});

await build({
  ...shared,
  entryPoints: ["src/main/profile-sync/storage-revision-worker.ts"],
  outfile: "dist/main/profile-sync-storage-revision-worker.js",
  platform: "node",
  format: "esm",
});

await build({
  ...shared,
  entryPoints: ["src/main/native-cef-runtime.ts"],
  outfile: "dist/main/native-cef-runtime.js",
  platform: "node",
  format: "esm",
});

await build({
  ...shared,
  entryPoints: {
    shell: "src/preload/shell.ts",
    page: "src/preload/page.ts",
  },
  outdir: "dist/preload",
  platform: "node",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
});

await build({
  bundle: true,
  sourcemap: true,
  target: "chrome136",
  entryPoints: {
    "agent-overlay": "src/renderer/agent-overlay.ts",
    chat: "src/renderer/chat.ts",
    overview: "src/renderer/overview.ts",
    browser: "src/renderer/browser.ts",
  },
  outdir: "dist/renderer",
  platform: "browser",
  format: "iife",
});

await build({
  ...shared,
  entryPoints: ["src/agent/cli.ts"],
  outfile: "dist/agent/ufo-browser.js",
  platform: "node",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
});

await build({
  ...shared,
  entryPoints: ["src/tests/*.test.ts"],
  outdir: "dist/tests",
  platform: "node",
  format: "esm",
  external: ["electron"],
});

for (const name of ["agent-overlay", "chat", "overview", "browser"]) {
  await cp(`src/renderer/${name}.html`, `dist/renderer/${name}.html`);
}
await cp("src/renderer/agent-overlay.css", "dist/renderer/agent-overlay.css");
await cp("src/renderer/styles.css", "dist/renderer/styles.css");
await cp("resources/icon.png", "dist/renderer/app-icon.png");

await mkdir(join(dist, "bin"), { recursive: true });
if (process.platform === "darwin") {
  await run("/usr/bin/xcrun", [
    "swiftc",
    "native/macos/ufo-keychain-helper.swift",
    "-framework",
    "Security",
    "-O",
    "-o",
    join(dist, "bin", "ufo-keychain-helper"),
  ]);
  await chmod(join(dist, "bin", "ufo-keychain-helper"), 0o755);
  const nodeInclude = resolve(dirname(process.execPath), "../include/node");
  await run("/usr/bin/xcrun", [
    "clang++",
    "-std=c++17",
    "-fobjc-arc",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-DNAPI_VERSION=10",
    "-I",
    nodeInclude,
    "native/macos/ufo-transition-addon.mm",
    "-framework",
    "AppKit",
    "-framework",
    "QuartzCore",
    "-framework",
    "ImageIO",
    "-O2",
    "-o",
    join(dist, "bin", "ufo-transition.node"),
  ]);
  await chmod(join(dist, "bin", "ufo-transition.node"), 0o755);
  await run("/usr/bin/xcrun", [
    "clang++",
    "-std=c++17",
    "-fobjc-arc",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-DNAPI_VERSION=10",
    "-I",
    nodeInclude,
    "native/macos/ufo-browser-chrome-addon.mm",
    "-framework",
    "AppKit",
    "-framework",
    "QuartzCore",
    "-O2",
    "-o",
    join(dist, "bin", "ufo-browser-chrome.node"),
  ]);
  await chmod(join(dist, "bin", "ufo-browser-chrome.node"), 0o755);
}
for (const name of ["ufo-browser", "x-browser"]) {
  await cp("scripts/ufo-browser-launcher.sh", join(dist, "bin", name));
  await chmod(join(dist, "bin", name), 0o755);
}
console.log("UFO-Browser build complete");

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${signal || code})`));
    });
  });
}
