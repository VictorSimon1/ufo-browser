import { lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binRoot = resolve(
  process.env.UFO_BROWSER_CLI_BIN || join(homedir(), ".local/bin"),
);
const force = process.argv.includes("--force");

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a path`);
  }
  return value;
}

const appArgument = optionValue("--app") || process.env.UFO_BROWSER_APP_ROOT;
const appRoot = appArgument ? resolve(appArgument) : undefined;
const sourceRoots = appRoot
  ? [
      join(appRoot, "Contents/Resources/app.asar.unpacked/dist/bin"),
      join(appRoot, "Contents/Resources"),
    ]
  : [join(root, "dist/bin")];
if (appRoot && !appRoot.endsWith(".app")) {
  throw new Error(`--app must point to an App bundle: ${appRoot}`);
}

await mkdir(binRoot, { recursive: true, mode: 0o700 });

for (const name of ["ufo-browser", "x-browser"]) {
  let source;
  for (const candidateRoot of sourceRoots) {
    const candidate = join(candidateRoot, name);
    if (await lstat(candidate).then(() => true).catch(() => false)) {
      source = candidate;
      break;
    }
  }
  if (!source) throw new Error(`CLI executable is missing from the Native CEF App bundle: ${name}`);
  const target = join(binRoot, name);
  const state = await lstat(target).catch(() => null);
  if (state?.isSymbolicLink()) {
    const current = resolve(dirname(target), await readlink(target));
    if (current === source) {
      console.log(`Current: ${target} -> ${source}`);
      continue;
    }
  }
  if (state && !force) {
    throw new Error(
      `Refusing to replace existing CLI path: ${target}. Re-run with --force after reviewing it.`,
    );
  }

  const temporary = join(binRoot, `.${name}.install-${process.pid}`);
  await rm(temporary, { force: true });
  await symlink(source, temporary);
  if (state) await rm(target, { force: true });
  await rename(temporary, target);
  console.log(`Installed: ${target} -> ${source}`);
}
