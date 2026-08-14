import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NativeCefRuntime } from "../dist/main/native-cef-runtime.js";

let port;
const fixture = createServer((request, response) => {
  if (request.url === "/download") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": "attachment; filename=native-download.txt",
    });
    response.end("native cef download\n");
    return;
  }
  response.end("<!doctype html><title>Native Download</title><a id=download href=/download>download</a>");
});
await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", () => {
  port = fixture.address().port;
  resolveListen();
}));

const userData = await mkdtemp(join(tmpdir(), "ufo-native-download-"));
const runtime = new NativeCefRuntime({
  executable: join(resolve("."), "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host"),
  userDataDir: userData,
  url: `http://127.0.0.1:${port}/`,
  devtoolsSocket: join(userData, "devtools.sock"),
  useMockKeychain: true,
});
try {
  await runtime.start({ startupTimeoutMs: 15_000 });
  const browser = await runtime.connectBrowser();
  const pageTarget = (await browser.send("Target.getTargets")).targetInfos.find((target) => target.type === "page" && target.url.includes("127.0.0.1"));
  assert.ok(pageTarget);
  const page = await runtime.connect(pageTarget.targetId);
  const events = [];
  page.onEvent((event) => {
    if (event.method === "Page.downloadWillBegin" || event.method === "Page.downloadProgress") events.push(event);
  });
  await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: userData, eventsEnabled: true });
  await page.send("Page.enable");
  await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/download` });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !events.some((event) => event.method === "Page.downloadProgress" && ["completed", "canceled"].includes(event.params?.state))) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const willBegin = events.find((event) => event.method === "Page.downloadWillBegin");
  const completed = events.find((event) => event.method === "Page.downloadProgress" && event.params?.state === "completed");
  assert.ok(willBegin, `missing Page.downloadWillBegin: ${JSON.stringify(events)}`);
  assert.ok(completed, `missing completed download event: ${JSON.stringify(events)}`);
  const path = join(userData, willBegin.params.suggestedFilename);
  assert.equal(await readFile(path, "utf8"), "native cef download\n");
  console.log(JSON.stringify({ suggestedFilename: willBegin.params.suggestedFilename, progressState: completed.params.state, path }));
  await page.close();
  await browser.close();
} finally {
  await runtime.stop();
  fixture.close();
}
