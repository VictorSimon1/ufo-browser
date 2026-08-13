import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NativeCefApplication } from "../dist/main/native-cef-application.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userDataDir = await mkdtemp(join(tmpdir(), "ufo-native-app-smoke-"));
const executable = join(root, "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host");
await access(executable);
const app = new NativeCefApplication({
  userDataDir,
  cefExecutable: executable,
  useMockKeychain: true,
  env: { UFO_CEF_PRIVATE_BRIDGE: "1" },
});
if (!userDataDir.includes("ufo-native-app-smoke-")) {
  throw new Error(`Native app smoke must use an isolated data root: ${userDataDir}`);
}
try {
  const status = await app.start();
  if (!status.running || !status.agentPid || !status.overviewPid) {
    throw new Error(`Native CEF application did not start: ${JSON.stringify(status)}`);
  }
  console.log(JSON.stringify(status));
} finally {
  await app.stop();
}
