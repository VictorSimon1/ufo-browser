import { access, chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostApp = join(root, "native/cef-host/build/ufo-cef-host.app");
const outputRoot = join(root, "release-native");
const appName = "UFO-Browser.app";
const appRoot = join(outputRoot, appName);
const frameworkRoot = join(hostApp, "Contents/Frameworks");
const version = process.env.npm_package_version || "0.1.7";

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", env: process.env });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${command} ${args.join(" ")} failed (${signal || code})`)));
  });
}

async function main() {
  if (process.platform !== "darwin") throw new Error("Native macOS packaging requires macOS");
  if (!(await exists(hostApp))) throw new Error("Native CEF host is not built. Run npm run native:cef:build first.");
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(join(appRoot, "Contents/MacOS"), { recursive: true });
  await mkdir(join(appRoot, "Contents/Resources"), { recursive: true });
  await cp(frameworkRoot, join(appRoot, "Contents/Frameworks"), { recursive: true });
  // Keep the CEF executable under Contents/MacOS. Its generated rpath is
  // @executable_path/../Frameworks; moving it to Resources would make the
  // installed DMG unable to locate Chromium Embedded Framework.framework.
  await cp(join(hostApp, "Contents/MacOS/ufo-cef-host"), join(appRoot, "Contents/MacOS/ufo-cef-host"));
  await cp("dist/main/native-cef-agent.js", join(appRoot, "Contents/Resources/native-cef-agent.js"));
  await cp("dist/main/native-cef-application.js", join(appRoot, "Contents/Resources/native-cef-application.js"));
  await cp("dist/bin/ufo-keychain-helper", join(appRoot, "Contents/Resources/ufo-keychain-helper"));
  await cp("dist/agent/ufo-browser.js", join(appRoot, "Contents/Resources/ufo-browser.js"));
  await writeFile(join(appRoot, "Contents/Resources/ufo-browser"), '#!/bin/sh\nset -eu\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$ROOT/node" "$ROOT/ufo-browser.js" "$@"\n');
  await writeFile(join(appRoot, "Contents/Resources/x-browser"), '#!/bin/sh\nset -eu\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$ROOT/node" "$ROOT/ufo-browser.js" "$@"\n');
  await cp(process.execPath, join(appRoot, "Contents/Resources/node"));
  await cp("skills/ufo-browser", join(appRoot, "Contents/Resources/skills/ufo-browser"), { recursive: true });
  await cp("resources/icon.icns", join(appRoot, "Contents/Resources/icon.icns"));
  await run("/usr/bin/xcrun", ["clang++", "-std=c++17", "-fobjc-arc", "native/cef-host/native-launcher.mm", "-framework", "AppKit", "-O2", "-o", join(appRoot, "Contents/MacOS/ufo-browser-native")]);
  await writeFile(join(appRoot, "Contents/Resources/native-launch-env.sh"), `export UFO_BROWSER_NATIVE_AGENT_SCRIPT="$PWD/Contents/Resources/native-cef-application.js"\n`);
  await writeFile(join(appRoot, "Contents/Resources/native-launch.json"), `${JSON.stringify({ version, product: "UFO-Browser", cef: true })}\n`);
  await writeFile(join(appRoot, "Contents/Info.plist"), plist());
  await chmod(join(appRoot, "Contents/Resources/node"), 0o755);
  await chmod(join(appRoot, "Contents/MacOS/ufo-cef-host"), 0o755);
  await chmod(join(appRoot, "Contents/Resources/ufo-browser"), 0o755);
  await chmod(join(appRoot, "Contents/Resources/x-browser"), 0o755);
  const dmg = join(outputRoot, `UFO-Browser-${version}-native.dmg`);
  await run("/usr/bin/hdiutil", ["create", "-volname", `UFO-Browser ${version}`, "-srcfolder", appRoot, "-ov", "-format", "UDZO", dmg]);
  console.log(`Native app: ${appRoot}`);
  console.log(`Native DMG: ${dmg}`);
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>UFO-Browser</string>
<key>CFBundleExecutable</key><string>ufo-browser-native</string>
<key>CFBundleIdentifier</key><string>com.ufobrowser.app.native</string>
<key>CFBundleName</key><string>UFO-Browser</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>`;
}

await main();
