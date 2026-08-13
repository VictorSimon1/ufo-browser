import { NativeCefRuntime } from "../dist/main/native-cef-runtime.js";

const runtime = new NativeCefRuntime({
  url: "https://example.com",
  port: Number(process.env.UFO_CEF_SMOKE_PORT || 9333),
  userDataDir: process.env.UFO_CEF_SMOKE_USER_DATA_DIR,
});
try {
  const version = await runtime.start();
  const deadline = Date.now() + 15_000;
  let targets = [];
  while (Date.now() < deadline) {
    targets = await runtime.targets();
    const page = targets.find((target) => target.type === "page" && target.url === "https://example.com/");
    if (page?.webSocketDebuggerUrl) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const page = targets.find((target) => target.type === "page" && target.url === "https://example.com/");
  if (!page?.webSocketDebuggerUrl) throw new Error("Native CEF example page did not become ready");
  const connection = await runtime.connect(page.id);
  let evaluated;
  const evaluateDeadline = Date.now() + 15_000;
  while (Date.now() < evaluateDeadline) {
    evaluated = await connection.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    });
    if (evaluated?.result?.value === "https://example.com/") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await connection.close();
  if (evaluated?.result?.value !== "https://example.com/") {
    throw new Error(`Unexpected native page URL: ${evaluated?.result?.value}`);
  }
  console.log(JSON.stringify({
    browser: version.Browser,
    protocol: version["Protocol-Version"],
    targets: targets.length,
    page: evaluated.result.value,
  }, null, 2));
} finally {
  await runtime.stop();
}
