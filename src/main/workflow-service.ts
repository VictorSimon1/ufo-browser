import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTraceSignal } from "./agent-trace.js";
import {
  redactEventData,
  type SpaceEvent,
  SpaceEventJournal,
} from "./space-event-journal.js";

export type WorkflowSlot = {
  name: string;
  required: true;
};

export type WorkflowTarget = {
  locator: string;
  context?: "page" | "popup";
  role?: string;
  name?: string;
  label?: string;
  parent?: { role?: string; name?: string };
  adjacent?: { before?: string; after?: string };
  nth?: number;
  selfHealLocator?: string;
};

export type WorkflowActionCache = {
  strategy: string;
  locator: string;
  validatedAt: number;
  hits: number;
  misses: number;
};

export type WorkflowWait = {
  kind: "navigation" | "popup" | "dialog" | "download";
  timeoutMs: number;
  urlContains?: string;
  dialogType?: string;
};

export type WorkflowCondition = {
  kind:
    | "urlContains"
    | "targetUnique"
    | "targetVisible"
    | "inputMatches"
    | "checked"
    | "actionCompleted";
  value?: string;
  slot?: { kind: "variable" | "secret"; name: string };
};

export type WorkflowStep = {
  id: string;
  action:
    | "goto"
    | "click"
    | "dblclick"
    | "fill"
    | "secretFill"
    | "press"
    | "check"
    | "uncheck"
    | "selectOption"
    | "site.runTool"
    | "site.runBrowserTool";
  target?: WorkflowTarget;
  url?: string;
  value?:
    | { kind: "variable" | "secret"; name: string }
    | { kind: "literal"; value: string };
  key?: string;
  checked?: boolean;
  siteTool?: {
    siteId: string;
    toolName: string;
    args: unknown;
  };
  preconditions: WorkflowCondition[];
  assertions: WorkflowCondition[];
  waits: WorkflowWait[];
  actionCache?: WorkflowActionCache;
  risk?: {
    level: "high";
    reason: string;
    domain?: string;
    action: string;
  };
};

export type WorkflowRecipe = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: number;
  createdAt: number;
  source: {
    spaceId: number;
    traceStartSequence: number;
    traceEndSequence: number;
  };
  variables: WorkflowSlot[];
  secrets: WorkflowSlot[];
  steps: WorkflowStep[];
  integrations: {
    learnedSiteTools: boolean;
  };
  stats: WorkflowStats;
};

export type WorkflowStats = {
  runs: number;
  successes: number;
  failures: number;
  lastRunAt?: number;
  lastStatus?: "success" | "failed";
  lastDurationMs?: number;
  actionCache?: {
    hits: number;
    misses: number;
    fallbacks: number;
    updates: number;
  };
};

export type WorkflowActionCacheObservation = {
  stepId: string;
  outcome: "hit" | "miss" | "fallback" | "seed";
  strategy?: string;
  locator?: string;
};

export type WorkflowFinishOptions = {
  variables?: string[] | Record<string, unknown>;
  secrets?: string[] | Record<string, unknown>;
};

type WorkflowStore = {
  schemaVersion: 1;
  workflows: Array<{
    name: string;
    versions: WorkflowRecipe[];
  }>;
};

type RecordedTraceStep = {
  stepId: string;
  action: string;
  target?: unknown;
  startedAt: number;
  finishedAt?: number;
  startSequence: number;
  endSequence?: number;
  status?: "success" | "failed";
  error?: unknown;
};

type ActiveRecording = {
  id: string;
  connectionId: string;
  spaceId: number;
  name: string;
  startedAt: number;
  startSequence: number;
  pending: Map<string, RecordedTraceStep>;
  steps: RecordedTraceStep[];
  overflowed: boolean;
};

type ActiveReplay = {
  runId: string;
  connectionId: string;
  spaceId: number;
  name: string;
  version: number;
  startedAt: number;
  startSequence: number;
};

type WorkflowServiceOptions = {
  directory?: string;
  maxWorkflows?: number;
  maxVersionsPerWorkflow?: number;
  maxRecordedSteps?: number;
  now?: () => number;
};

const STORE_FILE = "workflows.json";
const DEFAULT_MAX_WORKFLOWS = 100;
const DEFAULT_MAX_VERSIONS = 10;
const DEFAULT_MAX_RECORDED_STEPS = 500;
const SENSITIVE_FIELD =
  /pass(word)?|secret|token|authorization|cookie|otp|one.?time|pin|credential|api.?key|card|cvv|security.?code/i;
const HIGH_RISK_ACTION =
  /pay|purchase|buy|place.?order|submit.?order|send|publish|post|delete|remove|book|reserve|confirm|create.?account|register|sign.?up|save.?changes|change.?password|transfer/i;

export class WorkflowService {
  private store: WorkflowStore = { schemaVersion: 1, workflows: [] };
  private readonly activeRecordings = new Map<string, ActiveRecording>();
  private readonly activeReplays = new Map<string, ActiveReplay>();
  private readonly maxWorkflows: number;
  private readonly maxVersionsPerWorkflow: number;
  private readonly maxRecordedSteps: number;
  private readonly now: () => number;
  private writeQueue = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly journal: SpaceEventJournal,
    private readonly options: WorkflowServiceOptions = {},
  ) {
    this.maxWorkflows = positiveInteger(
      options.maxWorkflows,
      DEFAULT_MAX_WORKFLOWS,
    );
    this.maxVersionsPerWorkflow = positiveInteger(
      options.maxVersionsPerWorkflow,
      DEFAULT_MAX_VERSIONS,
    );
    this.maxRecordedSteps = positiveInteger(
      options.maxRecordedSteps,
      DEFAULT_MAX_RECORDED_STEPS,
    );
    this.now = options.now ?? Date.now;
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.options.directory) return;
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const parsed = await readJson(join(this.options.directory, STORE_FILE));
    if (validStore(parsed)) {
      this.store = boundStore(
        parsed,
        this.maxWorkflows,
        this.maxVersionsPerWorkflow,
      );
    }
  }

  start(connectionId: string, spaceId: number, nameValue: unknown) {
    const name = workflowName(nameValue);
    if (this.activeRecordings.has(connectionId)) {
      throw new Error("EGO_WORKFLOW_RECORDING_ACTIVE");
    }
    const id = randomUUID();
    const startSequence = this.journal.list(spaceId, { limit: 1 }).latestSequence;
    this.activeRecordings.set(connectionId, {
      id,
      connectionId,
      spaceId,
      name,
      startedAt: this.now(),
      startSequence,
      pending: new Map(),
      steps: [],
      overflowed: false,
    });
    return { id, name, spaceId, startedAt: this.now(), startSequence };
  }

  captureTrace(
    connectionId: string,
    spaceId: number,
    signal: AgentTraceSignal,
    event?: SpaceEvent,
  ) {
    const recording = this.activeRecordings.get(connectionId);
    if (!recording || recording.spaceId !== spaceId) return;
    const stepId = typeof signal.stepId === "string" ? signal.stepId : undefined;
    if (!stepId) return;
    if (signal.phase === "started") {
      if (
        recording.steps.length + recording.pending.size >=
        this.maxRecordedSteps
      ) {
        recording.overflowed = true;
        return;
      }
      recording.pending.set(stepId, {
        stepId,
        action: safeAction(signal.action),
        target: cloneTransient(signal.target),
        startedAt: event?.at ?? this.now(),
        startSequence: event?.sequence ?? recording.startSequence,
      });
      return;
    }
    const pending = recording.pending.get(stepId);
    if (!pending) return;
    recording.pending.delete(stepId);
    pending.finishedAt = event?.at ?? this.now();
    pending.endSequence = event?.sequence;
    pending.status = signal.status === "failed" ? "failed" : "success";
    pending.error = cloneTransient(signal.error);
    recording.steps.push(pending);
  }

  async finish(
    connectionId: string,
    spaceId: number,
    recordingId: unknown,
    options: WorkflowFinishOptions = {},
  ) {
    const recording = this.assertRecording(
      connectionId,
      spaceId,
      recordingId,
    );
    if (recording.overflowed) {
      throw new Error(
        `EGO_WORKFLOW_RECORDING_LIMIT: maximum ${this.maxRecordedSteps} steps`,
      );
    }
    if (recording.pending.size) {
      throw new Error("EGO_WORKFLOW_ACTION_PENDING");
    }
    const latestSequence = this.journal.list(spaceId, { limit: 1 }).latestSequence;
    const events = this.recordingEvents(spaceId, recording.startSequence);
    const existing = this.store.workflows.find(
      (workflow) => workflow.name === recording.name,
    );
    const version = (existing?.versions.at(-1)?.version ?? 0) + 1;
    const recipe = compileWorkflow(recording, events, options, {
      version,
      traceEndSequence: latestSequence,
      now: this.now(),
    });
    assertRecipeContainsNoRecordedSecrets(recipe, recording);
    if (existing) {
      existing.versions.push(recipe);
      existing.versions = existing.versions.slice(-this.maxVersionsPerWorkflow);
    } else {
      this.store.workflows.push({ name: recording.name, versions: [recipe] });
      this.store.workflows = this.store.workflows.slice(-this.maxWorkflows);
    }
    this.activeRecordings.delete(connectionId);
    await this.persist();
    return structuredClone(recipe);
  }

  cancel(connectionId: string, spaceId: number, recordingId: unknown) {
    const recording = this.assertRecording(
      connectionId,
      spaceId,
      recordingId,
    );
    this.activeRecordings.delete(connectionId);
    return { cancelled: true, id: recording.id, name: recording.name };
  }

  list() {
    return {
      workflows: this.store.workflows.map((workflow) => {
        const latest = workflow.versions.at(-1)!;
        ensureActionCacheStats(latest.stats);
        return {
          name: workflow.name,
          latestVersion: latest.version,
          versions: workflow.versions.map((recipe) => recipe.version),
          steps: latest.steps.length,
          variables: latest.variables.map((slot) => slot.name),
          secrets: latest.secrets.map((slot) => slot.name),
          stats: structuredClone(latest.stats),
          updatedAt: latest.createdAt,
        };
      }),
      limit: this.maxWorkflows,
    };
  }

  get(nameValue: unknown, versionValue?: unknown) {
    const recipe = this.findRecipe(nameValue, versionValue);
    ensureActionCacheStats(recipe.stats);
    return structuredClone(recipe);
  }

  prepareReplay(
    connectionId: string,
    spaceId: number,
    nameValue: unknown,
    options: { version?: unknown } = {},
  ) {
    const recipe = this.findRecipe(nameValue, options?.version);
    ensureActionCacheStats(recipe.stats);
    const runId = randomUUID();
    const startSequence = this.journal.list(spaceId, { limit: 1 }).latestSequence;
    this.activeReplays.set(runId, {
      runId,
      connectionId,
      spaceId,
      name: recipe.name,
      version: recipe.version,
      startedAt: this.now(),
      startSequence,
    });
    return {
      runId,
      spaceId,
      startSequence,
      recipe: structuredClone(recipe),
    };
  }

  async finishReplay(
    connectionId: string,
    spaceId: number,
    runIdValue: unknown,
    result: {
      status?: unknown;
      durationMs?: unknown;
      actionCache?: unknown;
    } = {},
  ) {
    const runId = requiredId(runIdValue, "workflow replay runId");
    const run = this.activeReplays.get(runId);
    if (
      !run ||
      run.connectionId !== connectionId ||
      run.spaceId !== spaceId
    ) {
      throw new Error("EGO_WORKFLOW_REPLAY_NOT_FOUND");
    }
    this.activeReplays.delete(runId);
    if (result.status === "waitingApproval") {
      return { recorded: false, status: "waitingApproval" };
    }
    const status = result.status === "success" ? "success" : "failed";
    const recipe = this.findRecipe(run.name, run.version);
    recipe.stats.runs += 1;
    if (status === "success") recipe.stats.successes += 1;
    else recipe.stats.failures += 1;
    recipe.stats.lastRunAt = this.now();
    recipe.stats.lastStatus = status;
    recipe.stats.lastDurationMs = finiteDuration(result.durationMs);
    const actionCache = ensureActionCacheStats(recipe.stats);
    for (const observation of actionCacheObservations(result.actionCache)) {
      const step = recipe.steps.find((candidate) => candidate.id === observation.stepId);
      if (!step?.target) continue;
      if (observation.outcome === "hit") {
        if (
          !step.actionCache ||
          step.actionCache.strategy !== observation.strategy ||
          step.actionCache.locator !== observation.locator
        ) {
          continue;
        }
        actionCache.hits += 1;
        step.actionCache.hits += 1;
        continue;
      }
      if (
        (observation.outcome === "miss" ||
          observation.outcome === "fallback") &&
        !step.actionCache
      ) {
        continue;
      }
      if (observation.outcome === "seed" && step.actionCache) continue;
      const allowed =
        observation.outcome === "fallback" || observation.outcome === "seed"
          ? actionCacheCandidates(step.target).find(
              (candidate) =>
                candidate.strategy === observation.strategy &&
                candidate.locator === observation.locator,
            )
          : undefined;
      if (
        (observation.outcome === "fallback" ||
          observation.outcome === "seed") &&
        !allowed
      ) {
        continue;
      }
      if (observation.outcome === "miss" || observation.outcome === "fallback") {
        actionCache.misses += 1;
        if (step.actionCache) step.actionCache.misses += 1;
      }
      if (observation.outcome === "fallback") actionCache.fallbacks += 1;
      if (
        observation.outcome === "fallback" ||
        observation.outcome === "seed"
      ) {
        step.actionCache = {
          strategy: allowed!.strategy,
          locator: allowed!.locator,
          validatedAt: this.now(),
          hits: 0,
          misses: 0,
        };
        actionCache.updates += 1;
      }
    }
    await this.persist();
    return { recorded: true, status, stats: structuredClone(recipe.stats) };
  }

  disconnect(connectionId: string) {
    this.activeRecordings.delete(connectionId);
    for (const [runId, run] of this.activeReplays) {
      if (run.connectionId === connectionId) this.activeReplays.delete(runId);
    }
  }

  async flush() {
    await this.writeQueue.catch(() => undefined);
  }

  private assertRecording(
    connectionId: string,
    spaceId: number,
    recordingId: unknown,
  ) {
    const id = requiredId(recordingId, "workflow recording id");
    const recording = this.activeRecordings.get(connectionId);
    if (
      !recording ||
      recording.id !== id ||
      recording.spaceId !== spaceId
    ) {
      throw new Error("EGO_WORKFLOW_RECORDING_NOT_FOUND");
    }
    return recording;
  }

  private findRecipe(nameValue: unknown, versionValue?: unknown) {
    const name = workflowName(nameValue);
    const workflow = this.store.workflows.find((entry) => entry.name === name);
    if (!workflow) throw new Error(`EGO_WORKFLOW_NOT_FOUND: ${name}`);
    if (versionValue === undefined || versionValue === null) {
      return workflow.versions.at(-1)!;
    }
    const version = Number(versionValue);
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new TypeError("workflow version must be a positive integer");
    }
    const recipe = workflow.versions.find((entry) => entry.version === version);
    if (!recipe) {
      throw new Error(`EGO_WORKFLOW_VERSION_NOT_FOUND: ${name}@${version}`);
    }
    return recipe;
  }

  private async persist() {
    if (!this.options.directory) return;
    const snapshot = structuredClone(this.store);
    const directory = this.options.directory;
    const target = join(directory, STORE_FILE);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
          mode: 0o600,
        });
        await rename(temporary, target);
      });
    await this.writeQueue;
  }

  private recordingEvents(spaceId: number, startSequence: number) {
    const events: SpaceEvent[] = [];
    let after = startSequence;
    while (events.length < 2_000) {
      const page = this.journal.list(spaceId, { after, limit: 1_000 });
      events.push(...page.events);
      if (!page.events.length || page.nextSequence <= after) break;
      after = page.nextSequence;
      if (after >= page.latestSequence) break;
    }
    return events;
  }
}

function compileWorkflow(
  recording: ActiveRecording,
  events: SpaceEvent[],
  options: WorkflowFinishOptions,
  context: { version: number; traceEndSequence: number; now: number },
): WorkflowRecipe {
  const slots = new SlotCompiler(options);
  const ordered = [...recording.steps].sort(
    (left, right) => left.startedAt - right.startedAt,
  );
  const unsupported = ordered.filter(
    (step) =>
      step.status === "success" &&
      !actionKind(step.action) &&
      !ignorableRecordingAction(step.action),
  );
  if (unsupported.length) {
    throw new Error(
      `EGO_WORKFLOW_UNSUPPORTED_ACTION: ${unique(
        unsupported.map((step) => step.action),
      ).join(", ")}`,
    );
  }
  const actionable = ordered.filter(
    (step) => step.status === "success" && actionKind(step.action),
  );
  const waits = ordered.filter(
    (step) =>
      step.status === "success" &&
      (step.action === "page.waitForEvent" ||
        step.action === "page.waitForURL" ||
        step.action === "page.waitForLoadState"),
  );
  if (!actionable.length) throw new Error("EGO_WORKFLOW_EMPTY");
  const steps = actionable.map((recorded, index) => {
    const nextStartedAt = actionable[index + 1]?.startedAt ?? context.now;
    return compileStep(
      recorded,
      events.filter(
        (event) =>
          event.at >= recorded.startedAt && event.at <= nextStartedAt,
      ),
      waits.filter(
        (wait) =>
          wait.startedAt <= (recorded.finishedAt ?? recorded.startedAt) &&
          (wait.finishedAt ?? context.now) >= recorded.startedAt,
      ),
      slots,
      index,
    );
  });
  return {
    schemaVersion: 1,
    id: randomUUID(),
    name: recording.name,
    version: context.version,
    createdAt: context.now,
    source: {
      spaceId: recording.spaceId,
      traceStartSequence: recording.startSequence,
      traceEndSequence: context.traceEndSequence,
    },
    variables: slots.variables(),
    secrets: slots.secrets(),
    steps,
    integrations: {
      learnedSiteTools: steps.some((step) => step.action.startsWith("site.")),
    },
    stats: {
      runs: 0,
      successes: 0,
      failures: 0,
      actionCache: { hits: 0, misses: 0, fallbacks: 0, updates: 0 },
    },
  };
}

function compileStep(
  recorded: RecordedTraceStep,
  events: SpaceEvent[],
  waitSteps: RecordedTraceStep[],
  slots: SlotCompiler,
  index: number,
): WorkflowStep {
  let action = actionKind(recorded.action)!;
  const raw = objectValue(recorded.target);
  if (recorded.action === "locator.check" && raw.checked === false) {
    action = "uncheck";
  }
  const selector = targetSelector(raw);
  const target = selector
    ? workflowTarget(selector, {
        ...objectValue(raw.semantics),
        pageContext: raw.pageContext,
      })
    : undefined;
  if (requiresTarget(action) && !target) {
    throw new Error(
      `EGO_WORKFLOW_UNSUPPORTED_TARGET: ${recorded.action} must use a locator, not coordinates`,
    );
  }
  const recordedUrl = safeOptional(
    objectValue(raw.semantics).pageUrl,
    2_048,
  );
  const eventWaits = compileWaits(events, waitSteps);
  const domain = domainForStep(raw, events);
  const risk = highRisk(recorded.action, target, domain);
  const step: WorkflowStep = {
    id: `step-${index + 1}`,
    action,
    target,
    preconditions: [
      ...(action !== "goto" && recordedUrl
        ? [
            {
              kind: "urlContains" as const,
              value: safeUrlExpectation(recordedUrl),
            },
          ]
        : []),
      ...(target
        ? ([{ kind: "targetUnique" }, { kind: "targetVisible" }] as WorkflowCondition[])
        : []),
    ],
    assertions: [],
    waits: eventWaits,
    actionCache: target
      ? {
          strategy: "original-locator",
          locator: target.locator,
          validatedAt: recorded.finishedAt ?? recorded.startedAt,
          hits: 0,
          misses: 0,
        }
      : undefined,
    risk,
  };

  if (action === "goto") {
    const url = String(raw.url ?? raw.target ?? "");
    step.url = slots.templateUrl(url);
    step.assertions.push({
      kind: "urlContains",
      value: safeUrlExpectation(url),
    });
  } else if (action === "fill" || action === "secretFill") {
    const compiled = slots.valueForTarget(target!, raw.value);
    step.action = compiled.kind === "secret" ? "secretFill" : "fill";
    step.value = compiled;
    step.assertions.push({ kind: "inputMatches", slot: compiled });
  } else if (action === "press") {
    step.key = safeLiteral(raw.key ?? raw.value ?? raw.target, 128);
    step.assertions.push({ kind: "actionCompleted" });
  } else if (action === "check" || action === "uncheck") {
    step.checked = action === "check";
    step.assertions.push({ kind: "checked", value: String(step.checked) });
  } else if (action === "selectOption") {
    const compiled = slots.valueForTarget(target!, raw.value);
    step.value = compiled;
    step.assertions.push({ kind: "inputMatches", slot: compiled });
  } else if (action === "site.runTool" || action === "site.runBrowserTool") {
    const siteId = safeLiteral(raw.siteId, 128);
    const toolName = safeLiteral(raw.toolName, 128);
    step.siteTool = {
      siteId,
      toolName,
      args: slots.templateObject(raw.args, `${siteId}_${toolName}`),
    };
    step.assertions.push({ kind: "actionCompleted" });
  } else {
    const navigation = eventWaits.find(
      (wait) => wait.kind === "navigation" && wait.urlContains,
    );
    step.assertions.push(
      navigation
        ? { kind: "urlContains", value: navigation.urlContains }
        : { kind: "actionCompleted" },
    );
  }
  return step;
}

class SlotCompiler {
  private readonly variableNames: string[];
  private readonly secretNames: string[];
  private readonly usedVariables = new Set<string>();
  private readonly usedSecrets = new Set<string>();
  private generatedValue = 1;
  private generatedSecret = 1;

  constructor(options: WorkflowFinishOptions) {
    this.variableNames = slotNames(options.variables, "variable");
    this.secretNames = slotNames(options.secrets, "secret");
  }

  valueForTarget(target: WorkflowTarget, _value: unknown) {
    const semantic = [
      target.locator,
      target.role,
      target.name,
      target.label,
      target.parent?.name,
    ]
      .filter(Boolean)
      .join(" ");
    const sensitive = SENSITIVE_FIELD.test(semantic);
    if (sensitive) {
      const name =
        this.match(this.secretNames, semantic, this.usedSecrets) ??
        uniqueSlotName(inferSlotName(semantic, "secret"), this.usedSecrets, () =>
          `secret${this.generatedSecret++}`,
        );
      this.usedSecrets.add(name);
      return { kind: "secret" as const, name };
    }
    const variable = this.match(
      this.variableNames,
      semantic,
      this.usedVariables,
    );
    if (variable) {
      this.usedVariables.add(variable);
      return { kind: "variable" as const, name: variable };
    }
    const unusedSecret = this.secretNames.find(
      (name) => !this.usedSecrets.has(name),
    );
    if (unusedSecret && this.variableNames.length === 0) {
      this.usedSecrets.add(unusedSecret);
      return { kind: "secret" as const, name: unusedSecret };
    }
    const unusedVariable = this.variableNames.find(
      (name) => !this.usedVariables.has(name),
    );
    const name =
      unusedVariable ??
      uniqueSlotName(inferSlotName(semantic, "value"), this.usedVariables, () =>
        `value${this.generatedValue++}`,
      );
    this.usedVariables.add(name);
    return { kind: "variable" as const, name };
  }

  templateUrl(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      if (SENSITIVE_FIELD.test(value)) {
        const name = this.addGeneratedSecret("urlSecret");
        return `\${${name}}`;
      }
      return safeLiteral(value, 2_048);
    }
    url.username = "";
    url.password = "";
    for (const [key] of url.searchParams) {
      const variable = this.match(
        this.variableNames,
        key,
        this.usedVariables,
      );
      if (variable) {
        this.usedVariables.add(variable);
        url.searchParams.set(key, `\${${variable}}`);
        continue;
      }
      if (SENSITIVE_FIELD.test(key)) {
        const name = this.addGeneratedSecret(inferSlotName(key, "urlSecret"));
        url.searchParams.set(key, `\${${name}}`);
      }
    }
    if (SENSITIVE_FIELD.test(url.hash)) {
      const name = this.addGeneratedSecret("urlHash");
      url.hash = `#\${${name}}`;
    }
    return url.toString();
  }

  templateObject(value: unknown, prefix: string): unknown {
    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item, index) =>
        this.templateObject(item, `${prefix}_${index + 1}`),
      );
    }
    if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value).slice(0, 100)) {
        if (child && typeof child === "object") {
          output[key] = this.templateObject(child, `${prefix}_${key}`);
          continue;
        }
        const sensitive = SENSITIVE_FIELD.test(key);
        const set = sensitive ? this.usedSecrets : this.usedVariables;
        const name = uniqueSlotName(
          inferSlotName(`${prefix}_${key}`, sensitive ? "secret" : "value"),
          set,
          () => `${sensitive ? "secret" : "value"}${sensitive ? this.generatedSecret++ : this.generatedValue++}`,
        );
        set.add(name);
        output[key] = { slot: sensitive ? "secret" : "variable", name };
      }
      return output;
    }
    const name = uniqueSlotName(
      inferSlotName(prefix, "value"),
      this.usedVariables,
      () => `value${this.generatedValue++}`,
    );
    this.usedVariables.add(name);
    return { slot: "variable", name };
  }

  variables() {
    return unique([...this.usedVariables]).map((name) => ({
      name,
      required: true as const,
    }));
  }

  secrets() {
    return unique([...this.usedSecrets]).map((name) => ({
      name,
      required: true as const,
    }));
  }

  private match(names: string[], semantic: string, used: Set<string>) {
    const normalized = normalizeWords(semantic);
    return names.find(
      (name) =>
        !used.has(name) && normalized.includes(normalizeWords(name)),
    );
  }

  private addGeneratedSecret(preferred: string) {
    const name = uniqueSlotName(preferred, this.usedSecrets, () =>
      `secret${this.generatedSecret++}`,
    );
    this.usedSecrets.add(name);
    return name;
  }
}

function compileWaits(events: SpaceEvent[], waitSteps: RecordedTraceStep[]) {
  const waits: WorkflowWait[] = [];
  for (const waitStep of waitSteps) {
    const eventName = String(objectValue(waitStep.target).eventName ?? "");
    if (eventName === "popup" || eventName === "download") {
      waits.push({ kind: eventName, timeoutMs: 20_000 });
    }
  }
  for (const event of events) {
    if (event.category === "navigation" && typeof event.data?.url === "string") {
      waits.push({
        kind: "navigation",
        timeoutMs: 20_000,
        urlContains: safeUrlExpectation(event.data.url),
      });
    } else if (
      event.category === "dialog" &&
      event.type.endsWith("javascriptDialogOpening")
    ) {
      waits.push({
        kind: "dialog",
        timeoutMs: 10_000,
        dialogType:
          typeof event.data?.type === "string" ? event.data.type : undefined,
      });
    } else if (
      event.category === "download" &&
      event.type.endsWith("downloadWillBegin")
    ) {
      waits.push({ kind: "download", timeoutMs: 20_000 });
    }
  }
  return dedupeWaits(waits);
}

function workflowTarget(selector: string, semanticsValue: unknown): WorkflowTarget {
  const parsed = selectorSemantics(selector);
  const semantics = objectValue(semanticsValue);
  return compactObject({
    locator: safeLiteral(selector, 2_048),
    context: semantics.pageContext === "popup" ? "popup" : undefined,
    role: safeOptional(semantics.role ?? parsed.role, 128),
    name: safeOptional(semantics.name ?? parsed.name, 256),
    label: safeOptional(semantics.label ?? parsed.label, 256),
    parent: compactObject({
      role: safeOptional(objectValue(semantics.parent).role ?? parsed.parent?.role, 128),
      name: safeOptional(objectValue(semantics.parent).name ?? parsed.parent?.name, 256),
    }),
    adjacent: compactObject({
      before: safeOptional(objectValue(semantics.adjacent).before, 256),
      after: safeOptional(objectValue(semantics.adjacent).after, 256),
    }),
    nth:
      nonNegativeInteger(semantics.nth) ?? parsed.nth,
    selfHealLocator: safeOptional(
      semantics.selfHealLocator ??
        (selector.startsWith("@") || selector.startsWith("loc=")
          ? selector
          : undefined),
      2_048,
    ),
  }) as WorkflowTarget;
}

function actionCacheCandidates(target: WorkflowTarget) {
  const candidates = [
    { strategy: "original-locator", locator: target.locator },
    ...(target.role && target.name
      ? [
          {
            strategy: "role-name",
            locator: `role:${target.role}[name=${JSON.stringify(target.name)}]`,
          },
        ]
      : []),
    ...(target.label
      ? [
          {
            strategy: "label",
            locator: `label:${JSON.stringify(target.label)}`,
          },
        ]
      : []),
    ...(target.parent?.role && target.parent.name && target.role
      ? [
          {
            strategy: "parent-semantics",
            locator: `role:${target.parent.role}[name=${JSON.stringify(target.parent.name)}] >> role:${target.role}[name=${JSON.stringify(target.name ?? "")}]`,
          },
        ]
      : []),
    ...(target.adjacent?.before
      ? [
          {
            strategy: "adjacent-before",
            locator: `text:${JSON.stringify(target.adjacent.before)} >> following-sibling::*[1]`,
          },
        ]
      : []),
    ...(target.adjacent?.after
      ? [
          {
            strategy: "adjacent-after",
            locator: `text:${JSON.stringify(target.adjacent.after)} >> preceding-sibling::*[1]`,
          },
        ]
      : []),
    ...(target.selfHealLocator && target.selfHealLocator !== target.locator
      ? [
          {
            strategy: "unique-self-heal",
            locator: target.selfHealLocator,
          },
        ]
      : []),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.strategy}:${candidate.locator}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectorSemantics(selector: string): Partial<WorkflowTarget> {
  const result: Partial<WorkflowTarget> = {};
  let source = selector;
  const nth = /^internal:nth=(\d+);([\s\S]+)$/.exec(source);
  if (nth) {
    result.nth = Number(nth[1]);
    source = nth[2];
  }
  const role = /(?:^|;)loc=role:([^\[;]+)(?:\[name=(.+)\])?$/.exec(source);
  if (role) {
    result.role = role[1];
    result.name = parseSerializedMatcher(role[2]);
  }
  const label = /(?:^|;)loc=label:(?:exact:)?(.+)$/.exec(source);
  if (label) result.label = parseSerializedMatcher(label[1]);
  if (source.startsWith("internal:scope:")) {
    const scope = parseInternalSelector(source, "scope");
    if (scope) {
      const parent = selectorSemantics(String(scope.base ?? ""));
      result.parent = { role: parent.role, name: parent.name };
      Object.assign(result, selectorSemantics(String(scope.child ?? "")), {
        parent: result.parent,
        nth: result.nth,
      });
    }
  }
  return result;
}

function parseInternalSelector(selector: string, kind: string) {
  const prefix = `internal:${kind}:`;
  if (!selector.startsWith(prefix)) return undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(selector.slice(prefix.length)));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseSerializedMatcher(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return value.replace(/^['"]|['"]$/g, "");
  }
}

function actionKind(action: string): WorkflowStep["action"] | undefined {
  switch (action) {
    case "gotoAndWait":
    case "page.goto":
      return "goto";
    case "click":
    case "locator.click":
      return "click";
    case "doubleClick":
    case "locator.dblclick":
      return "dblclick";
    case "fillInput":
    case "locator.fill":
      return "fill";
    case "locator.press":
    case "pressKey":
      return "press";
    case "locator.check":
      return "check";
    case "locator.uncheck":
      return "uncheck";
    case "locator.selectOption":
      return "selectOption";
    case "site.runTool":
      return "site.runTool";
    case "site.runBrowserTool":
      return "site.runBrowserTool";
    default:
      return undefined;
  }
}

function ignorableRecordingAction(action: string) {
  return (
    action === "snapshotText" ||
    action === "captureScreenshot" ||
    action === "page.snapshot" ||
    action === "page.snapshotRaw" ||
    action === "page.screenshot" ||
    action === "page.waitForEvent" ||
    action === "page.waitForURL" ||
    action === "page.waitForLoadState"
  );
}

function requiresTarget(action: WorkflowStep["action"]) {
  return ![
    "goto",
    "press",
    "site.runTool",
    "site.runBrowserTool",
  ].includes(action);
}

function targetSelector(raw: Record<string, any>) {
  const candidate = raw.locator ?? raw.target;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

function highRisk(
  action: string,
  target: WorkflowTarget | undefined,
  domain?: string,
): WorkflowStep["risk"] | undefined {
  if (!/click|press|check|select/i.test(action)) return undefined;
  const description = [target?.locator, target?.role, target?.name, target?.label]
    .filter(Boolean)
    .join(" ");
  if (!HIGH_RISK_ACTION.test(description)) return undefined;
  return {
    level: "high",
    reason: "Recorded target may perform an irreversible external action",
    domain,
    action: actionKind(action) ?? action,
  };
}

function domainForStep(raw: Record<string, any>, events: SpaceEvent[]) {
  const values = [
    raw.url,
    objectValue(raw.semantics).pageUrl,
    ...events
      .filter((event) => event.category === "navigation")
      .map((event) => event.data?.url),
  ];
  for (const value of values.reverse()) {
    if (typeof value !== "string") continue;
    try {
      return new URL(value).hostname;
    } catch {
      continue;
    }
  }
  return undefined;
}

function safeUrlExpectation(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 2_048);
  } catch {
    return safeLiteral(value, 2_048).replace(/[?#].*$/, "");
  }
}

function assertRecipeContainsNoRecordedSecrets(
  recipe: WorkflowRecipe,
  recording: ActiveRecording,
) {
  const serialized = JSON.stringify(recipe);
  for (const step of recording.steps) {
    const raw = objectValue(step.target);
    const candidates = collectSensitiveValues(raw);
    for (const candidate of candidates) {
      if (candidate.length >= 3 && serialized.includes(candidate)) {
        throw new Error("EGO_WORKFLOW_REDACTION_FAILED");
      }
    }
  }
  if (/"(?:password|otp|pin|token|cookie|authorization)"\s*:\s*"(?!\$\{)/i.test(serialized)) {
    throw new Error("EGO_WORKFLOW_REDACTION_FAILED");
  }
}

function collectSensitiveValues(value: unknown, key = "", output: string[] = []) {
  if (typeof value === "string" && SENSITIVE_FIELD.test(key)) {
    output.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectSensitiveValues(item, key, output));
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      collectSensitiveValues(child, childKey, output);
    }
  }
  return output;
}

function slotNames(value: unknown, label: string) {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.keys(value)
      : [];
  return unique(
    values.map((name) => {
      if (typeof name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
        throw new TypeError(`workflow ${label} names must be identifiers`);
      }
      return name;
    }),
  );
}

function workflowName(value: unknown) {
  if (typeof value !== "string") {
    throw new TypeError("workflow name must be a string");
  }
  const name = value.trim();
  if (!name || name.length > 128 || /[\u0000-\u001f]/.test(name)) {
    throw new TypeError("workflow name must contain 1-128 printable characters");
  }
  return name;
}

function requiredId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function safeAction(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 128)
    : "unknown";
}

function safeLiteral(value: unknown, maxLength: number) {
  const redacted = redactEventData(String(value ?? ""));
  return String(redacted ?? "").slice(0, maxLength);
}

function safeOptional(value: unknown, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return safeLiteral(value.trim(), maxLength);
}

function inferSlotName(value: string, fallback: string) {
  const normalized = value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length >= 2 && !["loc", "role", "input"].includes(part.toLowerCase()))
    .slice(-3)
    .map((part, index) =>
      index === 0
        ? part.toLowerCase()
        : `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`,
    )
    .join("");
  const candidate = normalized.replace(/^[^a-zA-Z]+/, "").slice(0, 64);
  return candidate || fallback;
}

function uniqueSlotName(
  preferred: string,
  used: Set<string>,
  fallback: () => string,
) {
  const candidate = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(preferred)
    ? preferred
    : fallback();
  if (!used.has(candidate)) return candidate;
  let index = 2;
  while (used.has(`${candidate}${index}`)) index += 1;
  return `${candidate}${index}`;
}

function normalizeWords(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function dedupeWaits(waits: WorkflowWait[]) {
  const seen = new Set<string>();
  return waits.filter((wait) => {
    const key = JSON.stringify(wait);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finiteDuration(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : { target: value };
}

function compactObject(value: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => {
      if (child === undefined || child === null || child === "") return false;
      if (child && typeof child === "object" && !Array.isArray(child)) {
        return Object.keys(child).length > 0;
      }
      return true;
    }),
  );
}

function cloneTransient<T>(value: T): T {
  if (value === undefined) return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function boundStore(
  store: WorkflowStore,
  maxWorkflows: number,
  maxVersions: number,
): WorkflowStore {
  return {
    schemaVersion: 1,
    workflows: store.workflows.slice(-maxWorkflows).map((workflow) => ({
      name: workflow.name,
      versions: workflow.versions.slice(-maxVersions).map(normalizeRecipe),
    })),
  };
}

function normalizeRecipe(recipe: WorkflowRecipe) {
  ensureActionCacheStats(recipe.stats);
  for (const step of recipe.steps ?? []) {
    if (!step.actionCache) continue;
    const allowed = step.target
      ? actionCacheCandidates(step.target).some(
          (candidate) =>
            candidate.strategy === step.actionCache?.strategy &&
            candidate.locator === step.actionCache?.locator,
        )
      : false;
    if (!allowed) delete step.actionCache;
  }
  return recipe;
}

function ensureActionCacheStats(stats: WorkflowStats) {
  stats.actionCache ??= { hits: 0, misses: 0, fallbacks: 0, updates: 0 };
  return stats.actionCache;
}

function actionCacheObservations(value: unknown) {
  if (!Array.isArray(value)) return [];
  const observations: WorkflowActionCacheObservation[] = [];
  const seenSteps = new Set<string>();
  for (const item of value.slice(0, DEFAULT_MAX_RECORDED_STEPS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const input = item as Record<string, unknown>;
    if (
      typeof input.stepId !== "string" ||
      seenSteps.has(input.stepId) ||
      !["hit", "miss", "fallback", "seed"].includes(String(input.outcome))
    ) {
      continue;
    }
    seenSteps.add(input.stepId);
    observations.push({
      stepId: input.stepId.slice(0, 128),
      outcome: input.outcome as WorkflowActionCacheObservation["outcome"],
      strategy:
        typeof input.strategy === "string"
          ? input.strategy.slice(0, 128)
          : undefined,
      locator:
        typeof input.locator === "string"
          ? input.locator.slice(0, 2_048)
          : undefined,
    });
  }
  return observations;
}

function validStore(value: unknown): value is WorkflowStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || !Array.isArray(input.workflows)) return false;
  return input.workflows.every((workflow) => {
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
      return false;
    }
    const entry = workflow as Record<string, unknown>;
    return typeof entry.name === "string" && Array.isArray(entry.versions);
  });
}

async function readJson(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}
