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
  // Node's fs.cp can materialize CEF framework symlinks as absolute links to
  // the build tree. That works in-place but breaks after a DMG drag-install.
  // ditto preserves the framework's relative Versions/A links and is the
  // canonical macOS bundle copier.
  await run("/usr/bin/ditto", [
    join(frameworkRoot, "Chromium Embedded Framework.framework"),
    join(appRoot, "Contents/Frameworks/Chromium Embedded Framework.framework"),
  ]);
  for (const helper of [
    "ufo-cef-host Helper.app",
    "ufo-cef-host Helper (Alerts).app",
    "ufo-cef-host Helper (GPU).app",
    "ufo-cef-host Helper (Plugin).app",
    "ufo-cef-host Helper (Renderer).app",
  ]) {
    const source = join(frameworkRoot, helper);
    if (await exists(source)) await run("/usr/bin/ditto", [source, join(appRoot, "Contents/Frameworks", helper)]);
  }
  // The CEF host is the UFO product executable itself. There is no outer
  // launcher and no second browser-host process; its generated rpath still
  // resolves the bundled Chromium framework from Contents/Frameworks.
  await cp(join(hostApp, "Contents/MacOS/ufo-cef-host"), join(appRoot, "Contents/MacOS/UFO-Browser"));
  await cp("dist/main/native-cef-agent.js", join(appRoot, "Contents/Resources/native-cef-agent.js"));
  await cp("dist/main/profile-sync-storage-revision-worker.js", join(appRoot, "Contents/Resources/profile-sync-storage-revision-worker.js"));
  await cp("dist/bin/ufo-keychain-helper", join(appRoot, "Contents/Resources/ufo-keychain-helper"));
  await cp("dist/agent/ufo-browser.js", join(appRoot, "Contents/Resources/ufo-browser.js"));
  await cp("dist/renderer", join(appRoot, "Contents/Resources/renderer"), { recursive: true });
  // The post-install CLI is a symlink in ~/.local/bin. Resolve that symlink
  // before locating the bundled Node/runtime, otherwise a dragged-in DMG
  // searches for ufo-browser.js beside the symlink instead of inside the App.
  const cliLauncher = [
    "#!/bin/sh",
    "set -eu",
    "SELF=\"$0\"",
    "while [ -L \"$SELF\" ]; do",
    "  SELF_DIR=\"$(CDPATH= cd -- \"$(dirname -- \"$SELF\")\" && pwd)\"",
    "  LINK=\"$(readlink \"$SELF\")\"",
    "  case \"$LINK\" in",
    "    /*) SELF=\"$LINK\" ;;",
    "    *) SELF=\"$SELF_DIR/$LINK\" ;;",
    "  esac",
    "done",
    "ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$SELF\")\" && pwd)\"",
    "exec \"$ROOT/node\" \"$ROOT/ufo-browser.js\" \"$@\"",
    "",
  ].join("\n");
  await writeFile(join(appRoot, "Contents/Resources/ufo-browser"), cliLauncher);
  await writeFile(join(appRoot, "Contents/Resources/x-browser"), cliLauncher);
  await cp(process.execPath, join(appRoot, "Contents/Resources/node"));
  await cp("skills/ufo-browser", join(appRoot, "Contents/Resources/skills/ufo-browser"), { recursive: true });
  await cp("resources/icon.icns", join(appRoot, "Contents/Resources/icon.icns"));
  await writeFile(join(appRoot, "Contents/Resources/native-launch.json"), `${JSON.stringify({ version, product: "UFO-Browser", cef: true })}\n`);
  await writeFile(join(appRoot, "Contents/Info.plist"), plist());
  await chmod(join(appRoot, "Contents/Resources/node"), 0o755);
  await chmod(join(appRoot, "Contents/MacOS/UFO-Browser"), 0o755);
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
<key>CFBundleExecutable</key><string>UFO-Browser</string>
<key>CFBundleIdentifier</key><string>com.ufobrowser.app.native</string>
<key>CFBundleName</key><string>UFO-Browser</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSPrincipalClass</key><string>UfoCefApplication</string>
<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>`;
}

await main();
