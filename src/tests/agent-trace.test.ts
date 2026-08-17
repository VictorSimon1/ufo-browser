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
  const space = {
    id: 7,
    name: "Trace Space",
    activeTabId: "tab-1",
    tabs: [{ targetId: "tab-1", url: "https://example.test/start" }],
  };
  const manager = {
    getSpace: (id: number) => (id === 7 ? space : undefined),
  };
  const trace = new AgentTraceService(journal, manager as any);
  trace.receive("connection-1", 7, {
    phase: "started",
    stepId: "step-1",
    action: "fillInput",
    label: "Fill password",
    target: {
      target: 'internal:nth=1;loc=role:textbox[name="Password"]',
      value: "top-secret",
    },
  }, { leaseGeneration: 9 });
  journal.append({
    spaceId: 7,
    tabId: "tab-1",
    category: "navigation",
    type: "navigation.committed",
    data: { url: "https://example.test/account" },
  });
  space.tabs[0].url = "https://example.test/account";
  trace.receive("connection-1", 7, {
    phase: "finished",
    stepId: "step-1",
    action: "fillInput",
    status: "success",
    durationMs: 42,
    browserDurationMs: 31,
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
  assert.equal(events[0].data?.label, "Fill password");
  assert.equal(events[0].data?.leaseGeneration, 9);
  assert.deepEqual(events[0].data?.target, {
    target: 'internal:nth=1;loc=role:textbox[name="Password"]',
    value: "[redacted]",
    locator: 'internal:nth=1;loc=role:textbox[name="Password"]',
    role: "textbox",
    name: "Password",
    nth: 1,
  });
  assert.equal(events[1].data?.status, "success");
  assert.equal(events[1].data?.durationMs, 42);
  assert.equal(events[1].data?.browserDurationMs, 31);
  assert.equal(events[1].data?.beforeUrl, "https://example.test/start");
  assert.equal(events[1].data?.afterUrl, "https://example.test/account");
  assert.deepEqual(events[1].data?.execution, { outcome: "completed" });
  assert.deepEqual(
    (events[1].data?.relatedEvents as any[]).map((event) => event.type),
    ["navigation.committed"],
  );
  assert.equal(events[3].data?.status, "failed");
  assert.match(
    String((events[3].data?.error as any)?.message),
    /connection closed/i,
  );
  assert.deepEqual(events[3].data?.execution, {
    outcome: "connection-closed",
  });
  assert.doesNotMatch(JSON.stringify(events), /top-secret/);
});

test("AgentTraceService records structured failures and absolute screenshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-agent-trace-failure-"));
  try {
    const journal = new SpaceEventJournal();
    await journal.initialize();
    const manager = {
      getSpace: () => ({
        id: 5,
        name: "Failure Space",
        activeTabId: "tab-5",
        tabs: [{ targetId: "tab-5", url: "https://example.test/form" }],
      }),
    };
    const screenshot = join(root, "failure.png");
    const trace = new AgentTraceService(journal, manager as any);
    trace.receive("connection", 5, {
      phase: "started",
      stepId: "failed-click",
      action: "click",
      target: "@21",
    });
    trace.receive("connection", 5, {
      phase: "finished",
      stepId: "failed-click",
      action: "click",
      status: "failed",
      durationMs: 700,
      browserDurationMs: 640,
      error: {
        name: "TimeoutError",
        code: "EGO_ACTIONABILITY_FAILED",
        message: "button remained covered",
        reason: "intercepted",
        locator: "@21",
        interceptedBy: "div.modal-overlay",
        attempts: 3,
        screenshot,
      },
    });

    const event = trace.list(5, { limit: 20 }).events.at(-1)!;
    assert.equal(event.data?.screenshot, screenshot);
    assert.deepEqual(event.data?.execution, {
      outcome: "timeout",
      reason: "intercepted",
      locator: "@21",
      interceptedBy: "div.modal-overlay",
      attempts: 3,
    });
    assert.deepEqual(event.data?.error, {
      name: "TimeoutError",
      code: "EGO_ACTIONABILITY_FAILED",
      message: "button remained covered",
      reason: "intercepted",
      locator: "@21",
      interceptedBy: "div.modal-overlay",
      attempts: 3,
      screenshot,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
