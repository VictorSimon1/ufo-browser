import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NativeCefPrivateConnection,
  NativeCefRuntime,
} from "../dist/main/native-cef-runtime.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const userDataDir = await mkdtemp(join(tmpdir(), "ufo-shared-host-"));
const executable = join(
  root,
  "native/cef-host/build/ufo-cef-host.app/Contents/MacOS/ufo-cef-host",
);
const devtoolsSocket = join(userDataDir, "devtools.sock");
const controlSocket = join(userDataDir, "control.sock");
const manifestPath = join(userDataDir, "spaces.json");
const spaceAData = join(userDataDir, "Spaces", "101");
const spaceBData = join(userDataDir, "Spaces", "202");
await mkdir(spaceAData, { recursive: true });
await mkdir(spaceBData, { recursive: true });

const web = createServer((request, response) => {
  const label = request.url === "/space-a" ? "Space A"
    : request.url === "/space-b" ? "Space B"
      : "Overview";
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>${label}</title><h1>${label}</h1>`);
});
await new Promise((resolveListen, reject) => {
  web.once("error", reject);
  web.listen(0, "127.0.0.1", resolveListen);
});
const address = web.address();
if (!address || typeof address === "string") throw new Error("shared-host smoke HTTP server did not bind");
const origin = `http://127.0.0.1:${address.port}`;

await writeFile(manifestPath, JSON.stringify({
  spaces: [
    {
      id: 101,
      name: "Shared A",
      profileName: "Profile A",
      url: `${origin}/space-a`,
      cachePath: spaceAData,
      visible: false,
    },
    {
      id: 202,
      name: "Shared B",
      profileName: "Profile B",
      url: `${origin}/space-b`,
      cachePath: spaceBData,
      visible: false,
    },
  ],
}), "utf8");

const runtime = new NativeCefRuntime({
  executable,
  url: `${origin}/overview`,
  overview: true,
  userDataDir,
  controlSocket,
  devtoolsSocket,
  sharedSpaceManifest: manifestPath,
  useMockKeychain: true,
});

async function connectSpace(spaceId, expectedPath) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const connection = new NativeCefPrivateConnection(
      devtoolsSocket,
      "browser",
      `space:${spaceId}`,
    );
    try {
      await connection.send("Browser.getVersion");
      const targets = await connection.send("Target.getTargets");
      const target = targets?.targetInfos?.find((candidate) =>
        candidate.type === "page" && String(candidate.url).endsWith(expectedPath));
      if (!target?.targetId) throw new Error(`page target not ready for Space ${spaceId}`);
      const attached = await connection.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      connection.setDefaultSessionId(String(attached.sessionId));
      return { connection, target };
    } catch (error) {
      lastError = error;
      await connection.close().catch(() => undefined);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error(`shared Space ${spaceId} did not become ready: ${String(lastError)}`);
}

try {
  await runtime.start({ startupTimeoutMs: 20_000 });
  const first = await connectSpace(101, "/space-a");
  const second = await connectSpace(202, "/space-b");
  try {
    await first.connection.send("Runtime.evaluate", {
      expression: "localStorage.setItem('ufo-shared-host', 'space-a')",
    });
    await second.connection.send("Runtime.evaluate", {
      expression: "localStorage.setItem('ufo-shared-host', 'space-b')",
    });
    const firstValue = await first.connection.send("Runtime.evaluate", {
      expression: "localStorage.getItem('ufo-shared-host')",
      returnByValue: true,
    });
    const secondValue = await second.connection.send("Runtime.evaluate", {
      expression: "localStorage.getItem('ufo-shared-host')",
      returnByValue: true,
    });
    if (firstValue?.result?.value !== "space-a") {
      throw new Error(`Space A context leaked: ${JSON.stringify(firstValue)}`);
    }
    if (secondValue?.result?.value !== "space-b") {
      throw new Error(`Space B context leaked: ${JSON.stringify(secondValue)}`);
    }
    console.log(JSON.stringify({
      oneHostProcess: true,
      spaces: [
        { id: 101, target: first.target.targetId, value: firstValue.result.value },
        { id: 202, target: second.target.targetId, value: secondValue.result.value },
      ],
      isolatedRequestContexts: true,
    }));
  } finally {
    await first.connection.close();
    await second.connection.close();
  }
} finally {
  await runtime.stop();
  await new Promise((resolveClose) => web.close(() => resolveClose()));
  await rm(userDataDir, { recursive: true, force: true });
}
