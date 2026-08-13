import { access, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hostRoot = join(root, "native", "cef-host");
const buildRoot = join(hostRoot, "build");
const configuration = process.env.UFO_CEF_BUILD_TYPE || "Release";
const target = "ufo-cef-host";
const executableCandidates = [
  join(buildRoot, configuration, `${target}.app`, "Contents", "MacOS", target),
  join(buildRoot, `${target}.app`, "Contents", "MacOS", target),
];

function fail(message) {
  throw new Error(`[native:cef] ${message}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findCefRoot() {
  if (process.env.UFO_CEF_ROOT) return resolve(process.env.UFO_CEF_ROOT);
  const runtimeRoot = join(root, "test", "cef-runtime");
  if (!(await exists(runtimeRoot))) {
    fail("CEF distribution not found. Set UFO_CEF_ROOT to a CEF binary distribution.");
  }
  const candidates = (await readdir(runtimeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^cef_binary_.*_macos(arm64|x64)$/.test(entry.name))
    .map((entry) => join(runtimeRoot, entry.name))
    .sort();
  if (candidates.length === 0) {
    fail("No macOS CEF binary distribution found under test/cef-runtime. Set UFO_CEF_ROOT explicitly.");
  }
  return candidates.at(-1);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal || code})`));
    });
  });
}

function printToolchainHint() {
  console.error(
    "[native:cef] macOS CEF builds require full Xcode (ibtool), not only Command Line Tools.",
  );
  console.error(
    "[native:cef] Install Xcode, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
  );
}

async function configure() {
  if (process.platform !== "darwin") fail("The native CEF host currently targets macOS only.");
  const cefRoot = await findCefRoot();
  const arch = process.env.UFO_CEF_ARCH || process.arch;
  if (arch !== "arm64" && arch !== "x64") fail(`Unsupported CEF architecture: ${arch}`);
  await run("cmake", [
    "-S", hostRoot,
    "-B", buildRoot,
    "-G", "Ninja",
    `-DCMAKE_BUILD_TYPE=${configuration}`,
    `-DPROJECT_ARCH=${arch}`,
    `-DUFO_PRODUCT_VERSION=${process.env.npm_package_version || "0.1.7"}`,
    `-DCEF_ROOT=${cefRoot}`,
  ]);
  console.log(`[native:cef] configured with ${cefRoot}`);
}

async function build() {
  if (!(await exists(join(buildRoot, "build.ninja")))) await configure();
  try {
    await run("cmake", ["--build", buildRoot, "--target", target, "-j", process.env.CMAKE_BUILD_JOBS || "4"]);
  } catch (error) {
    if (String(error?.message || error).includes("ibtool")) printToolchainHint();
    throw error;
  }
  const builtExecutable = await findBuiltExecutable();
  console.log(`[native:cef] built ${dirname(dirname(dirname(builtExecutable)))}`);
}

async function findBuiltExecutable() {
  for (const candidate of executableCandidates) {
    if (await exists(candidate)) return candidate;
  }
  fail(`Native host executable was not found in ${executableCandidates.join(" or ")}`);
}

async function runHost() {
  const executable = await findBuiltExecutable().catch(() =>
    fail(`Native host is not built. Run \"npm run native:cef:build\" first.`),
  );
  const args = process.argv.slice(3);
  await run(executable, args);
}

const command = process.argv[2] || "help";
try {
  if (command === "configure") await configure();
  else if (command === "build") await build();
  else if (command === "run") await runHost();
  else {
    console.log("Usage: node scripts/native-cef.mjs <configure|build|run> [--url=...]");
    process.exitCode = command === "help" ? 0 : 1;
  }
} catch (error) {
  console.error(`[native:cef] ${error?.message || error}`);
  process.exitCode = 1;
}
