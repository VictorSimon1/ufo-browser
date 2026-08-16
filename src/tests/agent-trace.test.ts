import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentTraceService } from "../main/agent-trace.js";
import { SpaceEventJournal } from "../main/space-event-journal.js";

test("AgentTraceService correlates action steps and closes pending steps on disconnect", async () => {
  const journal = new SpaceEventJournal();
  await journal.initialize();
  const manager = {
    getSpace: (id: number) =>
      id === 7
        ? { id, name: "Trace Space", activeTabId: "tab-1" }
        : undefined,
  };
  const trace = new AgentTraceService(journal, manager as any);
  trace.receive("connection-1", 7, {
    phase: "started",
    stepId: "step-1",
    action: "fillInput",
    target: { target: "#password", value: "top-secret" },
  });
  trace.receive("connection-1", 7, {
    phase: "finished",
    stepId: "step-1",
    action: "fillInput",
    status: "success",
    durationMs: 42,
  });
  trace.receive("connection-1", 7, {
    phase: "started",
    stepId: "step-2",
    action: "click",
    target: "button.submit",
  });
  trace.disconnect("connection-1");

  const events = trace.list(7, { limit: 20 }).events;
  assert.equal(events.length, 4);
  assert.equal(events[1].data?.status, "success");
  assert.equal(events[1].data?.durationMs, 42);
  assert.equal(events[3].data?.status, "failed");
  assert.match(String(events[3].data?.error), /connection closed/i);
  assert.doesNotMatch(JSON.stringify(events), /top-secret/);
});

test("AgentTraceService exports local Markdown and JSON traces", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-agent-trace-"));
  try {
    const journal = new SpaceEventJournal();
    await journal.initialize();
    const manager = {
      getSpace: () => ({ id: 3, name: "Export Space", activeTabId: "tab-3" }),
    };
    const trace = new AgentTraceService(journal, manager as any);
    trace.receive("connection", 3, {
      phase: "started",
      stepId: "export-1",
      action: "click",
      target: "@21",
    });
    trace.receive("connection", 3, {
      phase: "finished",
      stepId: "export-1",
      action: "click",
      status: "success",
    });
    const markdownPath = join(root, "trace.md");
    const jsonPath = join(root, "trace.json");
    assert.equal((await trace.export(3, { path: markdownPath })).format, "markdown");
    assert.equal((await trace.export(3, { path: jsonPath })).format, "json");
    assert.match(await readFile(markdownPath, "utf8"), /Export Space Agent Trace/);
    assert.match(await readFile(jsonPath, "utf8"), /"action\.started"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
