import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
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
  outfile: "dist/agent/x-browser.js",
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

for (const name of ["agent-overlay", "chat", "overview", "browser", "newtab"]) {
  await cp(`src/renderer/${name}.html`, `dist/renderer/${name}.html`);
}
await cp("src/renderer/agent-overlay.css", "dist/renderer/agent-overlay.css");
await cp("src/renderer/styles.css", "dist/renderer/styles.css");

await mkdir(join(dist, "bin"), { recursive: true });
await cp("scripts/x-browser-launcher.sh", join(dist, "bin/x-browser"));
await chmod(join(dist, "bin/x-browser"), 0o755);
console.log("X-Browser build complete");
