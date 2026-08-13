import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NativeCefRuntime } from "../dist/main/native-cef-runtime.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userData = await mkdtemp(join(tmpdir(), "ufo-native-private-"));
const socket = join(userData, "devtools.sock");
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
const runtime = new NativeCefRuntime({
  executable,
  userDataDir: userData,
  url: "https://example.com/",
  controlSocket: join(userData, "control.sock"),
  devtoolsSocket: socket,
  useMockKeychain: true,
});
try {
  const version = await runtime.start({ startupTimeoutMs: 15_000 });
  const targets = await runtime.targets();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error(`Private CEF bridge returned no page target: ${JSON.stringify(targets)}`);
  // Browser-level transport is production-safe and verified here. Page/OOPIF
  // session forwarding remains opt-in until CEF Chrome Runtime's
  // Target.sendMessageToTarget semantics have a complete parity suite.
  console.log(JSON.stringify({ privateSocket: socket, browser: version.Browser, target: page.id, browserLevel: true }));
} finally {
  await runtime.stop();
}
