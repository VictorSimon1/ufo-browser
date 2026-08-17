import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executeWorkflowReplay,
  secret,
} from "../agent/workflow-replay.js";
import { SpaceEventJournal } from "../main/space-event-journal.js";
import {
  WorkflowService,
  type WorkflowRecipe,
} from "../main/workflow-service.js";

test("WorkflowService compiles versioned recipes without persisting recorded values", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-workflow-store-"));
  const email = "recorded-person@example.com";
  const password = "never-write-this-password";
  const token = "never-write-this-token";
  try {
    const journal = new SpaceEventJournal();
    await journal.initialize();
    const service = new WorkflowService(journal, { directory: root });
    await service.initialize();
    const recording = service.start("connection-1", 7, "register-flow");
    capture(service, journal, "connection-1", 7, "goto", "page.goto", {
      url: `https://fixture.local/register?token=${token}`,
    });
    capture(service, journal, "connection-1", 7, "email", "locator.fill", {
      locator: "#email",
      value: email,
      semantics: { role: "textbox", name: "Email", label: "Email" },
    });
    capture(service, journal, "connection-1", 7, "password", "locator.fill", {
      locator: "#password",
      value: password,
      semantics: {
        role: "textbox",
        name: "Password",
        label: "Password",
      },
    });
    capture(service, journal, "connection-1", 7, "continue", "locator.click", {
      locator: "#continue",
      semantics: { role: "button", name: "Continue" },
    });
    const recipe = await service.finish(
      "connection-1",
      7,
      recording.id,
      { variables: ["email"], secrets: ["password"] },
    );
    assert.equal(recipe.version, 1);
    assert.equal(recipe.steps.length, 4);
    assert.deepEqual(recipe.variables.map((slot) => slot.name), ["email"]);
    assert.ok(recipe.secrets.some((slot) => slot.name === "password"));
    assert.ok(recipe.secrets.some((slot) => slot.name !== "password"));
    assert.deepEqual(recipe.steps[1].value, {
      kind: "variable",
      name: "email",
    });
    assert.deepEqual(recipe.steps[2].value, {
      kind: "secret",
      name: "password",
    });

    const persisted = await readFile(join(root, "workflows.json"), "utf8");
    assert.doesNotMatch(persisted, /recorded-person@example\.com/);
    assert.doesNotMatch(persisted, /never-write-this-password/);
    assert.doesNotMatch(persisted, /never-write-this-token/);

    const restarted = new WorkflowService(journal, { directory: root });
    await restarted.initialize();
    assert.equal(restarted.get("register-flow").version, 1);
    const second = restarted.start("connection-2", 8, "register-flow");
    capture(restarted, journal, "connection-2", 8, "goto-2", "page.goto", {
      url: "https://fixture.local/register",
    });
    const versionTwo = await restarted.finish(
      "connection-2",
      8,
      second.id,
    );
    assert.equal(versionTwo.version, 2);
    assert.deepEqual(restarted.list().workflows[0].versions, [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow replay follows the finite recovery chain and never guesses among duplicates", async () => {
  const actionLog: string[] = [];
  const reports: any[] = [];
  const recipe = recipeWithStep({
    id: "step-1",
    action: "click",
    target: {
      locator: "#old-submit",
      role: "button",
      name: "Continue",
    },
    preconditions: [{ kind: "targetUnique" }, { kind: "targetVisible" }],
    assertions: [{ kind: "actionCompleted" }],
    waits: [],
  });
  const roleLocator = fakeLocator(1, () => actionLog.push("role-click"));
  const success = await executeWorkflowReplay(
    { runId: "run-1", startSequence: 0, recipe },
    {},
    {},
    fakeRuntime({
      locator: () => fakeLocator(0),
      getByRole: () => roleLocator,
      reports,
    }),
  );
  assert.equal(success.status, "success");
  assert.deepEqual(actionLog, ["role-click"]);
  assert.equal(reports.at(-1)?.status, "success");

  actionLog.length = 0;
  const ambiguous = await executeWorkflowReplay(
    { runId: "run-2", startSequence: 0, recipe },
    {},
    {},
    fakeRuntime({
      locator: () => fakeLocator(2, () => actionLog.push("wrong-click")),
      getByRole: () => fakeLocator(2, () => actionLog.push("wrong-role")),
      reports,
    }),
  );
  assert.equal(ambiguous.status, "failed");
  assert.deepEqual(actionLog, []);
  assert.match(
    String((ambiguous as any).recovery.error),
    /ambiguous|without guessing/i,
  );
  assert.ok(
    (ambiguous as any).recovery.currentCandidates.every(
      (candidate: any) => candidate.count === 2,
    ),
  );
});

test("high-risk Workflow steps wait for scoped caller approval and secrets stay wrapped", async () => {
  let clicks = 0;
  const reports: any[] = [];
  const recipe = recipeWithStep({
    id: "step-1",
    action: "click",
    target: {
      locator: "#send",
      role: "button",
      name: "Send",
    },
    preconditions: [{ kind: "targetUnique" }, { kind: "targetVisible" }],
    assertions: [{ kind: "actionCompleted" }],
    waits: [],
    risk: {
      level: "high",
      reason: "Sends an external message",
      domain: "fixture.local",
      action: "click",
    },
  });
  const runtime = fakeRuntime({
    locator: () => fakeLocator(1, () => clicks++),
    reports,
  });
  const waiting = await executeWorkflowReplay(
    { runId: "risk-1", startSequence: 0, recipe },
    {},
    {},
    runtime,
  );
  assert.equal(waiting.status, "waitingApproval");
  assert.equal(clicks, 0);
  assert.deepEqual((waiting as any).requiredApproval.policy, {
    highRisk: true,
    domains: ["fixture.local"],
    actions: ["click"],
  });

  const approved = await executeWorkflowReplay(
    { runId: "risk-2", startSequence: 0, recipe },
    {},
    {
      approval: {
        highRisk: true,
        domains: ["fixture.local"],
        actions: ["click"],
      },
    },
    runtime,
  );
  assert.equal(approved.status, "success");
  assert.equal(clicks, 1);

  const secretRecipe: WorkflowRecipe = {
    ...recipe,
    variables: [],
    secrets: [{ name: "password", required: true }],
    steps: [],
  };
  const rejected = await executeWorkflowReplay(
    { runId: "secret-1", startSequence: 0, recipe: secretRecipe },
    { password: "plaintext" },
    {},
    runtime,
  );
  assert.equal(rejected.status, "failed");
  assert.match(String((rejected as any).recovery.error), /secret\(\.\.\.\)/i);
  const accepted = await executeWorkflowReplay(
    { runId: "secret-2", startSequence: 0, recipe: secretRecipe },
    { password: secret("wrapped") },
    {},
    runtime,
  );
  assert.equal(accepted.status, "success");
});

test("Workflow storage is bounded and active recordings stay isolated by connection and Space", async () => {
  const journal = new SpaceEventJournal();
  await journal.initialize();
  const service = new WorkflowService(journal, {
    maxWorkflows: 2,
    maxVersionsPerWorkflow: 2,
  });
  await service.initialize();

  const left = service.start("left", 1, "left-flow");
  const right = service.start("right", 2, "right-flow");
  capture(service, journal, "left", 1, "left-goto", "page.goto", {
    url: "https://left.fixture/",
  });
  capture(service, journal, "right", 2, "right-goto", "page.goto", {
    url: "https://right.fixture/",
  });
  await assert.rejects(
    service.finish("left", 2, left.id),
    /RECORDING_NOT_FOUND/,
  );
  assert.equal((await service.finish("left", 1, left.id)).source.spaceId, 1);
  assert.equal((await service.finish("right", 2, right.id)).source.spaceId, 2);

  for (let version = 0; version < 3; version += 1) {
    const recording = service.start(`third-${version}`, 3, "third-flow");
    capture(
      service,
      journal,
      `third-${version}`,
      3,
      `third-goto-${version}`,
      "page.goto",
      { url: `https://third.fixture/${version}` },
    );
    await service.finish(`third-${version}`, 3, recording.id);
  }
  const list = service.list();
  assert.deepEqual(
    list.workflows.map((workflow) => workflow.name),
    ["right-flow", "third-flow"],
  );
  assert.deepEqual(
    list.workflows.find((workflow) => workflow.name === "third-flow")?.versions,
    [2, 3],
  );
});

test("Workflow replay carries a Popup facade into recorded popup-context steps", async () => {
  let popupValue = "";
  const popupLocator = {
    ...fakeLocator(1),
    fill: async (value: string) => {
      popupValue = value;
    },
    inputValue: async () => popupValue,
  };
  const popupPage = {
    locator: () => popupLocator,
    getByRole: () => popupLocator,
    getByLabel: () => popupLocator,
    url: async () => "https://popup.fixture/form",
  };
  const reports: any[] = [];
  const recipe: WorkflowRecipe = {
    ...recipeWithStep({
      id: "step-1",
      action: "click",
      target: { locator: "#open", role: "button", name: "Open" },
      preconditions: [{ kind: "targetUnique" }, { kind: "targetVisible" }],
      assertions: [{ kind: "actionCompleted" }],
      waits: [{ kind: "popup", timeoutMs: 1_000 }],
    }),
    variables: [{ name: "email", required: true }],
    steps: [
      {
        id: "step-1",
        action: "click",
        target: { locator: "#open", role: "button", name: "Open" },
        preconditions: [{ kind: "targetUnique" }, { kind: "targetVisible" }],
        assertions: [{ kind: "actionCompleted" }],
        waits: [{ kind: "popup", timeoutMs: 1_000 }],
      },
      {
        id: "step-2",
        action: "fill",
        target: {
          locator: "#popup-email",
          context: "popup",
          role: "textbox",
          name: "Email",
        },
        value: { kind: "variable", name: "email" },
        preconditions: [{ kind: "targetUnique" }, { kind: "targetVisible" }],
        assertions: [
          {
            kind: "inputMatches",
            slot: { kind: "variable", name: "email" },
          },
        ],
        waits: [],
      },
    ],
  };
  const runtime = fakeRuntime({
    locator: () => fakeLocator(1),
    reports,
  });
  (runtime.page as any).waitForEvent = async () => popupPage;
  const result = await executeWorkflowReplay(
    { runId: "popup-run", startSequence: 0, recipe },
    { email: "popup@example.com" },
    {},
    runtime,
  );
  assert.equal(result.status, "success");
  assert.equal(popupValue, "popup@example.com");
});

test("Workflow redaction covers OTP, Cookie, Authorization, and Token values", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-workflow-redaction-"));
  const values = {
    otp: "481516",
    cookie: "session=cookie-secret",
    authorization: "Bearer authorization-secret",
    token: "token-secret-value",
  };
  try {
    const journal = new SpaceEventJournal();
    await journal.initialize();
    const service = new WorkflowService(journal, { directory: root });
    await service.initialize();
    const recording = service.start("security", 9, "security-flow");
    capture(service, journal, "security", 9, "otp", "locator.fill", {
      locator: "#otp",
      value: values.otp,
      semantics: { role: "textbox", name: "OTP", label: "OTP" },
    });
    capture(service, journal, "security", 9, "site", "site.runTool", {
      siteId: "fixture-site",
      toolName: "secure-call",
      args: {
        cookie: values.cookie,
        authorization: values.authorization,
        token: values.token,
      },
    });
    const recipe = await service.finish("security", 9, recording.id, {
      secrets: ["otp"],
    });
    assert.equal(recipe.integrations.learnedSiteTools, true);
    const persisted = await readFile(join(root, "workflows.json"), "utf8");
    for (const value of Object.values(values)) {
      assert.equal(persisted.includes(value), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow compiler attaches navigation, Dialog, and Download waits and rejects coordinate macros", async () => {
  const journal = new SpaceEventJournal();
  await journal.initialize();
  const service = new WorkflowService(journal);
  await service.initialize();
  const recording = service.start("waits", 12, "wait-flow");
  const started = journal.append({
    spaceId: 12,
    connectionId: "waits",
    stepId: "send",
    category: "action",
    type: "action.started",
    data: { action: "locator.click" },
  });
  service.captureTrace(
    "waits",
    12,
    {
      phase: "started",
      stepId: "send",
      action: "locator.click",
      target: {
        locator: "#send",
        semantics: {
          role: "button",
          name: "Send",
          pageUrl: "https://fixture.local/compose",
        },
      },
    },
    started,
  );
  journal.append({
    spaceId: 12,
    category: "navigation",
    type: "Page.frameNavigated",
    data: { url: "https://fixture.local/sent?token=redacted" },
  });
  journal.append({
    spaceId: 12,
    category: "dialog",
    type: "Page.javascriptDialogOpening",
    data: { type: "confirm", message: "Confirm send" },
  });
  journal.append({
    spaceId: 12,
    category: "download",
    type: "Page.downloadWillBegin",
    data: { guid: "download-guid" },
  });
  const finished = journal.append({
    spaceId: 12,
    connectionId: "waits",
    stepId: "send",
    category: "action",
    type: "action.finished",
    data: { action: "locator.click", status: "success" },
  });
  service.captureTrace(
    "waits",
    12,
    {
      phase: "finished",
      stepId: "send",
      action: "locator.click",
      status: "success",
    },
    finished,
  );
  const recipe = await service.finish("waits", 12, recording.id);
  assert.deepEqual(
    recipe.steps[0].waits.map((wait) => wait.kind).sort(),
    ["dialog", "download", "navigation"],
  );
  assert.equal(recipe.steps[0].risk?.level, "high");
  assert.equal(recipe.steps[0].risk?.domain, "fixture.local");
  assert.deepEqual(recipe.steps[0].preconditions[0], {
    kind: "urlContains",
    value: "https://fixture.local/compose",
  });

  const coordinate = service.start("coordinate", 13, "coordinate-flow");
  capture(
    service,
    journal,
    "coordinate",
    13,
    "coordinate-click",
    "click",
    { target: [20, 30] },
  );
  await assert.rejects(
    service.finish("coordinate", 13, coordinate.id),
    /UNSUPPORTED_TARGET/,
  );
});

function capture(
  service: WorkflowService,
  journal: SpaceEventJournal,
  connectionId: string,
  spaceId: number,
  stepId: string,
  action: string,
  target: unknown,
) {
  const started = journal.append({
    spaceId,
    connectionId,
    stepId,
    category: "action",
    type: "action.started",
    data: { action },
  });
  service.captureTrace(
    connectionId,
    spaceId,
    { phase: "started", stepId, action, target },
    started,
  );
  const finished = journal.append({
    spaceId,
    connectionId,
    stepId,
    category: "action",
    type: "action.finished",
    data: { action, status: "success" },
  });
  service.captureTrace(
    connectionId,
    spaceId,
    { phase: "finished", stepId, action, status: "success" },
    finished,
  );
}

function recipeWithStep(step: WorkflowRecipe["steps"][number]): WorkflowRecipe {
  return {
    schemaVersion: 1,
    id: "recipe-id",
    name: "fixture-workflow",
    version: 1,
    createdAt: Date.now(),
    source: { spaceId: 1, traceStartSequence: 0, traceEndSequence: 0 },
    variables: [],
    secrets: [],
    steps: [step],
    integrations: { learnedSiteTools: false },
    stats: { runs: 0, successes: 0, failures: 0 },
  };
}

function fakeLocator(count: number, onClick: () => unknown = () => undefined) {
  return {
    count: async () => count,
    isVisible: async () => count > 0,
    click: async () => onClick(),
    dblclick: async () => onClick(),
    fill: async () => undefined,
    press: async () => undefined,
    check: async () => undefined,
    uncheck: async () => undefined,
    selectOption: async () => undefined,
    inputValue: async () => "",
    isChecked: async () => true,
    getByRole: () => fakeLocator(count, onClick),
  };
}

function fakeRuntime(options: {
  locator: (selector: string) => any;
  getByRole?: (role: string, options: any) => any;
  reports: any[];
}) {
  return {
    page: {
      locator: options.locator,
      getByRole: options.getByRole ?? options.locator,
      getByLabel: options.locator,
      url: async () => "https://fixture.local/register",
      snapshot: async () => ({ revision: 1, kind: "full", content: "" }),
      screenshot: async () => "/tmp/workflow-failure.png",
      waitForEvent: async () => undefined,
      waitForURL: async () => undefined,
      waitForTimeout: async () => undefined,
      info: async () => ({}),
      goto: async () => undefined,
      keyboard: { press: async () => undefined },
    },
    listEvents: async () => ({ events: [] }),
    report: async (result: any) => {
      options.reports.push(result);
      return { stats: {} };
    },
  };
}
