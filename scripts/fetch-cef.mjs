import { mkdir, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";

// CEF is a large, platform-specific third-party runtime and is intentionally
// not checked into Git. This helper keeps the native build reproducible while
// allowing the project to follow the latest stable CEF release.
const root = resolve(new URL("..", import.meta.url).pathname);
const runtimeRoot = resolve(process.env.UFO_CEF_RUNTIME_ROOT || join(root, "test/cef-runtime"));
const platform = process.platform === "darwin" ? (process.arch === "arm64" ? "macosarm64" : "macosx64") : undefined;
if (!platform) throw new Error("The automatic CEF fetcher currently supports macOS arm64/x64 only");

const indexUrl = "https://cef-builds.spotifycdn.com/index.json";
const index = await fetch(indexUrl).then(async (response) => {
  if (!response.ok) throw new Error(`CEF release index failed: HTTP ${response.status}`);
  return response.json();
});
const channel = process.env.UFO_CEF_CHANNEL || "stable";
const versions = (index[platform]?.versions || []).filter((item) => !channel || item.channel === channel);
const requested = process.env.UFO_CEF_VERSION;
const release = requested
  ? versions.find((item) => item.cef_version === requested)
  : versions[0];
if (!release) throw new Error(`CEF ${requested || "latest stable"} is unavailable for ${platform}`);
const file = release.files.find((item) => item.type === "standard");
if (!file) throw new Error(`CEF release ${release.cef_version} has no standard archive`);

await mkdir(runtimeRoot, { recursive: true });
const archive = join(runtimeRoot, file.name);
console.log(`[native:cef] downloading CEF ${release.cef_version} for ${platform}`);
const response = await fetch(`https://cef-builds.spotifycdn.com/${file.name}`);
if (!response.ok || !response.body) throw new Error(`CEF archive download failed: HTTP ${response.status}`);
await pipeline(response.body, createWriteStream(archive));
await run("tar", ["-xjf", archive, "-C", runtimeRoot]);
const extracted = (await readdir(runtimeRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith(`cef_binary_${release.cef_version}_${platform}`))
  .map((entry) => join(runtimeRoot, entry.name))
  .sort()
  .at(-1);
if (!extracted) throw new Error(`CEF archive extracted without an expected ${platform} directory`);
console.log(`[native:cef] ready: ${extracted}`);

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} failed (${code})`)));
  });
}
