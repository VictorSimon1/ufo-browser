import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadRegistry } from "../main/download-registry.js";

test("download registry routes a completed file to the owning connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "x-browser-download-test-"));
  const chromiumSession = new FakeSession();
  const emitted: any[] = [];
  const registry = new DownloadRegistry({
    locateSource: (id) =>
      id === 42 ? { spaceId: 7, targetId: "page-7" } : undefined,
    emit: (event) => emitted.push(event),
  });
  try {
    await registry.configure({
      connectionId: "owner",
      spaceId: 7,
      targetId: "page-7",
      scope: "browser",
      behavior: "allow",
      downloadPath: directory,
      session: chromiumSession as any,
    });
    const item = new FakeDownloadItem("report.txt", 5);
    chromiumSession.emit(
      "will-download",
      { preventDefault: () => assert.fail("allowed download was canceled") },
      item,
      { id: 42 },
    );
    assert.equal(item.savePath, join(directory, "report.txt"));
    await writeFile(item.savePath, "hello");
    item.receivedBytes = 5;
    item.emit("updated", {}, "progressing");
    item.emit("done", {}, "completed");
    for (let attempt = 0; attempt < 20; attempt++) {
      if (emitted.some((event) => event.params.state === "completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.deepEqual(
      emitted.map((event) => [event.connectionId, event.method, event.params.state]),
      [
        ["owner", "Page.downloadWillBegin", undefined],
        ["owner", "Page.downloadProgress", "inProgress"],
        ["owner", "Page.downloadProgress", "inProgress"],
        ["owner", "Page.downloadProgress", "completed"],
      ],
    );
    assert.equal(emitted[0].params.suggestedFilename, "report.txt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("page download behavior wins and canceled downloads stay isolated", async () => {
  const chromiumSession = new FakeSession();
  const emitted: any[] = [];
  const registry = new DownloadRegistry({
    locateSource: () => ({ spaceId: 3, targetId: "popup" }),
    emit: (event) => emitted.push(event),
  });
  await registry.configure({
    connectionId: "connection-a",
    spaceId: 3,
    targetId: "opener",
    scope: "browser",
    behavior: "deny",
    session: chromiumSession as any,
  });
  await registry.configure({
    connectionId: "connection-b",
    spaceId: 3,
    targetId: "popup",
    scope: "page",
    behavior: "deny",
    session: chromiumSession as any,
  });
  let prevented = false;
  chromiumSession.emit(
    "will-download",
    { preventDefault: () => (prevented = true) },
    new FakeDownloadItem("blocked.txt", 10),
    { id: 99 },
  );
  assert.equal(prevented, true);
  assert.deepEqual(
    emitted.map((event) => [event.connectionId, event.method, event.params.state]),
    [
      ["connection-b", "Page.downloadWillBegin", undefined],
      ["connection-b", "Page.downloadProgress", "canceled"],
    ],
  );
});

test("default behavior and connection cleanup restore unmanaged downloads", async () => {
  const chromiumSession = new FakeSession();
  const emitted: any[] = [];
  const registry = new DownloadRegistry({
    locateSource: () => ({ spaceId: 1, targetId: "page" }),
    emit: (event) => emitted.push(event),
  });
  await registry.configure({
    connectionId: "connection",
    spaceId: 1,
    targetId: "page",
    scope: "browser",
    behavior: "deny",
    session: chromiumSession as any,
  });
  await registry.configure({
    connectionId: "connection",
    spaceId: 1,
    targetId: "page",
    scope: "browser",
    behavior: "default",
    session: chromiumSession as any,
  });
  chromiumSession.emit(
    "will-download",
    { preventDefault: () => assert.fail("default behavior was still managed") },
    new FakeDownloadItem("default.txt", 1),
    { id: 1 },
  );
  assert.equal(emitted.length, 0);

  await registry.configure({
    connectionId: "connection",
    spaceId: 1,
    targetId: "page",
    scope: "browser",
    behavior: "deny",
    session: chromiumSession as any,
  });
  registry.removeConnection("connection");
  chromiumSession.emit(
    "will-download",
    { preventDefault: () => assert.fail("removed connection still managed") },
    new FakeDownloadItem("removed.txt", 1),
    { id: 1 },
  );
  assert.equal(emitted.length, 0);
});

class FakeSession extends EventEmitter {}

class FakeDownloadItem extends EventEmitter {
  savePath = "";
  receivedBytes = 0;

  constructor(
    private readonly filename: string,
    private readonly totalBytes: number,
  ) {
    super();
  }

  getURL() {
    return "https://example.com/download";
  }

  getFilename() {
    return this.filename;
  }

  getTotalBytes() {
    return this.totalBytes;
  }

  getReceivedBytes() {
    return this.receivedBytes;
  }

  setSavePath(value: string) {
    this.savePath = value;
  }
}
