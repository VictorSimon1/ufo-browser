import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentSocketPath } from "../agent/socket-path.js";

test("explicit Agent socket environment always wins", () => {
  assert.equal(resolveAgentSocketPath({
    UFO_BROWSER_SOCKET: "/tmp/ufo-explicit.sock",
    X_BROWSER_SOCKET: "/tmp/x-explicit.sock",
  }, "/tmp/work", "/tmp/home"), "/tmp/ufo-explicit.sock");
});

test("a stale test marker cannot shadow the installed UFO socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-agent-socket-path-"));
  const work = join(root, "work");
  const home = join(root, "home");
  const markerRoot = join(work, ".x-browser-test");
  const staleSocket = join(root, "missing-test.sock");
  const productSocket = join(
    home,
    "Library/Application Support/UFO-Browser/ufo-browser.sock",
  );
  try {
    await mkdir(markerRoot, { recursive: true });
    await mkdir(join(home, "Library/Application Support/UFO-Browser"), { recursive: true });
    await writeFile(join(markerRoot, "socket-path"), `${staleSocket}\n`);
    await writeFile(productSocket, "");
    assert.equal(resolveAgentSocketPath({}, work, home), productSocket);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live test socket marker still selects the isolated test App", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-agent-live-socket-"));
  const markerRoot = join(root, ".ufo-browser-test");
  const socketPath = join(root, "test.sock");
  try {
    await mkdir(markerRoot, { recursive: true });
    await writeFile(join(markerRoot, "socket-path"), `${socketPath}\n`);
    await writeFile(socketPath, "");
    assert.equal(resolveAgentSocketPath({}, root, join(root, "home")), socketPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
