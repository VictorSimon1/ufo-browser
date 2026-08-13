import { NativeCefRuntime } from "../dist/main/native-cef-runtime.js";

const runtime = new NativeCefRuntime({
  url: "https://example.com",
  port: Number(process.env.UFO_CEF_SMOKE_PORT || 9333),
  userDataDir: process.env.UFO_CEF_SMOKE_USER_DATA_DIR,
});
try {
  const version = await runtime.start();
  const targets = await runtime.targets();
  const connection = await runtime.connect();
  const evaluated = await connection.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true,
  });
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
