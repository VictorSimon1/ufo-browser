import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NativeCefRuntime } from "../dist/main/native-cef-runtime.js";

let port;
const fixture = createServer((request, response) => {
  response.end(`<!doctype html><title>Native Events</title><script>
    console.log('native-event-console');
    setTimeout(() => { fetch('/event-fetch'); }, 100);
    setTimeout(() => { throw new Error('native-event-error'); }, 250);
  </script>`);
});
await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", () => {
  port = fixture.address().port;
  resolveListen();
}));
const userData = await mkdtemp(join(tmpdir(), "ufo-native-events-"));
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
  const target = (await browser.send("Target.getTargets")).targetInfos.find((item) => item.type === "page" && item.url.includes("127.0.0.1"));
  assert.ok(target);
  const page = await runtime.connect(target.targetId);
  const events = [];
  page.onEvent((event) => {
    if (["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Network.requestWillBeSent"].includes(event.method)) events.push(event);
  });
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && !(events.some((event) => event.method === "Runtime.consoleAPICalled") && events.some((event) => event.method === "Network.requestWillBeSent" && event.params?.request?.url?.endsWith("/event-fetch")) && events.some((event) => event.method === "Runtime.exceptionThrown"))) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.ok(events.some((event) => event.method === "Runtime.consoleAPICalled"), JSON.stringify(events));
  assert.ok(events.some((event) => event.method === "Network.requestWillBeSent" && event.params?.request?.url?.endsWith("/event-fetch")), JSON.stringify(events));
  assert.ok(events.some((event) => event.method === "Runtime.exceptionThrown"), JSON.stringify(events));
  console.log(JSON.stringify({ console: true, request: true, pageerror: true }));
  await page.close();
  await browser.close();
} finally {
  await runtime.stop();
  fixture.close();
}
