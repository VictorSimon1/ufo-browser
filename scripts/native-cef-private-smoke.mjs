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
  const connection = await runtime.connect(page.id);
  const pageUrl = await connection.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true,
  });
  await connection.send("Page.enable");
  const title = await connection.send("Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true,
  });
  const screenshot = await connection.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true,
  });
  if (!String(title?.result?.value || "").includes("Example Domain")) {
    throw new Error(`Private CEF page Runtime.evaluate failed: ${JSON.stringify(title)}`);
  }
  if (!screenshot?.data) throw new Error("Private CEF page screenshot was empty");
  await connection.close();
  console.log(JSON.stringify({
    privateSocket: socket,
    browser: version.Browser,
    target: page.id,
    browserLevel: true,
    pageLevel: true,
    pageUrl: pageUrl?.result?.value,
    title: title?.result?.value,
    screenshot: true,
  }));
} finally {
  await runtime.stop();
}
