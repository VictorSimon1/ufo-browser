import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const userData = await mkdtemp(join(tmpdir(), "ufo-native-chrome-shell-"));
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
await access(executable);
const child = spawn(executable, ["--url=https://example.com/", `--user-data-dir=${userData}`, "--show-on-start"], {
  cwd: root,
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
try {
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        clearTimeout(timer);
        resolveReady();
      } else rejectReady(new Error(`CEF shell did not start\n${stderr}`));
    }, 3_000);
    child.once("error", rejectReady);
    child.once("exit", (code) => rejectReady(new Error(`CEF shell exited ${code}\n${stderr}`)));
  });
  assert.match(await readSource(join(root, "native/cef-host/app.cc")), /return CEF_CTT_NORMAL;/);
  assert.match(await readSource(join(root, "native/cef-host/app.cc")), /return CEF_RUNTIME_STYLE_CHROME;/);
  console.log(JSON.stringify({ chromeRuntime: true, nativeToolbar: true }));
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) return resolveExit();
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolveExit();
    }, 1_000);
    child.once("exit", () => { clearTimeout(timer); resolveExit(); });
  });
}

async function readSource(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
