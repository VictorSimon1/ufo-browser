import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NativeCefRuntime } from "../dist/main/native-cef-runtime.js";

let port;
const fixture = createServer((request, response) => {
  if (request.url === "/popup") {
    response.end("<!doctype html><title>Popup Child</title><button>Popup action</button>");
    return;
  }
  response.end("<!doctype html><title>Popup Main</title><button id=open>open</button>");
});
await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", () => {
  port = fixture.address().port;
  resolveListen();
}));
const userData = await mkdtemp(join(tmpdir(), "ufo-native-popup-"));
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
  console.error("popup:browser-ready");
  const page = (await browser.send("Target.getTargets")).targetInfos.find((target) => target.type === "page");
  console.error("popup:target", page?.targetId);
  assert.ok(page, "main page target missing");
  const pageConnection = await runtime.connect(page.targetId);
  console.error("popup:page-attached");
  await pageConnection.send("Runtime.evaluate", {
    expression: `void window.open('http://127.0.0.1:${port}/popup', 'native-popup'); true`,
    userGesture: true,
    returnByValue: true,
  });
  console.error("popup:opened");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  const targets = (await browser.send("Target.getTargets")).targetInfos;
  console.error("popup:targets", targets.map((target) => ({ id: target.targetId, type: target.type, title: target.title })));
  const popup = targets.find((target) => target.type === "page" && target.openerId === page.targetId);
  assert.ok(popup, `popup target missing: ${JSON.stringify(targets)}`);
  const popupConnection = await runtime.connect(popup.targetId);
  console.error("popup:popup-attached");
  const title = await popupConnection.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
  assert.equal(title?.result?.value, "Popup Child");
  await popupConnection.close();
  await pageConnection.close();
  await browser.close();
  console.log(JSON.stringify({ popupTarget: popup.targetId, title: title.result.value }));
} finally {
  await runtime.stop();
  fixture.close();
}
