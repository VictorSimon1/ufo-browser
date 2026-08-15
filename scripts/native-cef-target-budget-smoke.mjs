import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NativeCefRuntime,
  NativeCefSharedSpaceRuntime,
} from "../dist/main/native-cef-runtime.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userDataDir = await mkdtemp(join(tmpdir(), "ufo-native-target-budget-"));
const executable = join(
  root,
  "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host",
);
await access(executable);

const web = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>UFO Target Budget</title><h1>Target Budget</h1>");
});
await new Promise((resolveListen, reject) => {
  web.once("error", reject);
  web.listen(0, "127.0.0.1", resolveListen);
});
const address = web.address();
if (!address || typeof address === "string") throw new Error("target budget HTTP server did not bind");
const url = `http://127.0.0.1:${address.port}/`;
const controlSocket = join(userDataDir, "control.sock");
const devtoolsSocket = join(userDataDir, "devtools.sock");

const host = new NativeCefRuntime({
  executable,
  url,
  overview: true,
  userDataDir,
  controlSocket,
  devtoolsSocket,
  useMockKeychain: true,
});
const space = new NativeCefSharedSpaceRuntime(host, {
  id: 991,
  name: "Target Budget",
  profileName: "Default",
  url,
  cachePath: join(userDataDir, "Default"),
  visible: false,
  nativeChromeShell: true,
  chromeProfileDirectory: "Default",
  chromeUserDataRoot: userDataDir,
});

try {
  await host.start({ startupTimeoutMs: 20_000 });
  await space.start();
  const initialTargets = await space.targets();
  assert.ok(initialTargets.some((target) => target.type === "page"),
    "target budget Space did not expose a page target");

  const before = rendererCount(userDataDir);
  for (let index = 0; index < 30; index += 1) {
    const targets = await space.targets();
    assert.ok(targets.some((target) => target.type === "page"),
      `target enumeration lost its page on pass ${index}`);
  }
  const after = rendererCount(userDataDir);
  // Repeated target/preview polling must not create one renderer per probe.
  // Allow one normal Chromium replacement during the run, but reject growth
  // proportional to the number of enumeration passes.
  assert.ok(after <= before + 2,
    `renderer count grew during cached target polling: ${before} -> ${after}`);

  console.log(JSON.stringify({
    repeatedTargetPasses: 30,
    rendererCountBefore: before,
    rendererCountAfter: after,
    rendererGrowthBound: 2,
    cachedDirectFrameRoutes: true,
  }));
} finally {
  await space.stop().catch(() => undefined);
  await host.stop();
  await new Promise((resolveClose) => web.close(() => resolveClose()));
  await rm(controlSocket, { force: true }).catch(() => undefined);
  await rm(devtoolsSocket, { force: true }).catch(() => undefined);
  if (process.env.UFO_KEEP_TEST_DATA === "1") {
    console.error(`[target budget smoke] kept ${userDataDir}`);
  } else {
    await rm(userDataDir, { recursive: true, force: true });
  }
}

function rendererCount(dataDir) {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  const marker = `--user-data-dir=${dataDir}`;
  return output
    .split("\n")
    .filter((line) =>
      line.includes(marker) &&
      line.includes("ufo-cef-host Helper (Renderer)") &&
      line.includes("--type=renderer"),
    ).length;
}
