import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectAgentSocket,
  resolveSocketCandidates,
} from "../agent/socket-path.js";

test("explicit socket environment remains authoritative", () => {
  assert.deepEqual(
    resolveSocketCandidates({
      cwd: "/unused",
      home: "/unused",
      env: { UFO_BROWSER_SOCKET: "/explicit/ufo.sock" },
    }),
    ["/explicit/ufo.sock"],
  );
});

test("a stale test marker falls back to a live app socket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ufo-socket-path-"));
  const markerDir = join(root, ".x-browser-test");
  const staleSocket = join(root, "missing-test.sock");
  const liveSocket = join(
    root,
    "Library/Application Support/UFO-Browser/ufo-browser.sock",
  );
  await mkdir(markerDir, { recursive: true });
  await mkdir(join(root, "Library/Application Support/UFO-Browser"), {
    recursive: true,
  });
  await writeFile(join(markerDir, "socket-path"), `${staleSocket}\n`);

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(liveSocket, resolve);
  });
  t.after(() => server.close());

  const candidates = resolveSocketCandidates({ cwd: root, home: root, env: {} });
  assert.equal(candidates[0], staleSocket);
  assert.equal(candidates[1], liveSocket);
  const connected = await connectAgentSocket(candidates);
  assert.equal(connected.path, liveSocket);
  connected.socket.destroy();
});
