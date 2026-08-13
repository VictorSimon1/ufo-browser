import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { NativeCefRuntime } from "../dist/main/native-cef-runtime.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userDataDir = await mkdtemp(join(tmpdir(), "ufo-native-cef-version-"));
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
const runtime = new NativeCefRuntime({ executable, userDataDir, url: "https://example.com/" });
try {
  const version = await runtime.start({ port: await findFreePort() });
  const browser = String(version.Browser || "");
  if (!/(?:Chromium|Chrome)\/151\./.test(browser)) throw new Error(`Expected Chromium 151, got ${browser}`);
  if (!version.webSocketDebuggerUrl) throw new Error("Native CEF browser target is unavailable");
  console.log(JSON.stringify({ browser, protocol: version["Protocol-Version"] }));
} finally {
  await runtime.stop();
}

async function findFreePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!port) throw new Error("unable to allocate CEF version smoke port");
  return port;
}
