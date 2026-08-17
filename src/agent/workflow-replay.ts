import { randomUUID } from "node:crypto";
import type {
  WorkflowCondition,
  WorkflowRecipe,
  WorkflowStep,
  WorkflowTarget,
  WorkflowWait,
} from "../main/workflow-service.js";

type PreparedWorkflow = {
  runId: string;
  startSequence: number;
  recipe: WorkflowRecipe;
};

type WorkflowReplayOptions = {
  version?: number;
  timeoutMs?: number;
  approval?: {
    highRisk?: boolean;
    domains?: string[];
    actions?: string[];
  };
};

type WorkflowReplayRuntime = {
  page: any;
  site?: any;
  trace?: (signal: Record<string, unknown>) => void;
  listEvents?: (after: number, options?: Record<string, unknown>) => Promise<any>;
  report: (result: {
    status: "success" | "failed" | "waitingApproval";
    durationMs: number;
  }) => Promise<unknown>;
};

type SecretValue = {
  readonly __ufoWorkflowSecret: true;
  readonly value: unknown;
};

type ResolvedTarget = {
  locator: any;
  strategy: string;
  candidates: Array<{
    strategy: string;
    locator: string;
    count?: number;
    error?: string;
  }>;
};

export function secret(value: unknown): SecretValue {
  return Object.freeze({ __ufoWorkflowSecret: true, value });
}

export async function executeWorkflowReplay(
  prepared: PreparedWorkflow,
  inputsValue: unknown,
  options: WorkflowReplayOptions,
  runtime: WorkflowReplayRuntime,
) {
  const startedAt = performance.now();
  let initialSnapshot: any;
  try {
    const inputs = resolveInputs(prepared.recipe, inputsValue);
    let popupPage: any;
    initialSnapshot = await runtime.page
      .snapshot({
        format: "structured",
        interactive: true,
        compact: true,
      })
      .catch(() => undefined);
    for (let index = 0; index < prepared.recipe.steps.length; index += 1) {
      const step = prepared.recipe.steps[index];
      const stepPage = step.target?.context === "popup" ? popupPage : runtime.page;
      if (!stepPage) {
        const result = {
          ok: false as const,
          error: new Error("Workflow popup context is unavailable"),
        };
        const recovery = await failureRecovery(
          prepared,
          step,
          index,
          result,
          initialSnapshot,
          runtime,
        );
        const durationMs = performance.now() - startedAt;
        await runtime.report({ status: "failed", durationMs });
        return {
          status: "failed" as const,
          workflow: prepared.recipe.name,
          version: prepared.recipe.version,
          recovery,
        };
      }
      const stepRuntime = { ...runtime, page: stepPage };
      const approval = await requiredApproval(step, options, stepPage);
      if (approval) {
        const durationMs = performance.now() - startedAt;
        await runtime.report({
          status: "waitingApproval",
          durationMs,
        });
        return {
          status: "waitingApproval" as const,
          workflow: prepared.recipe.name,
          version: prepared.recipe.version,
          stepIndex: index,
          stepId: step.id,
          requiredApproval: approval,
        };
      }
      const result = await executeStep(
        step,
        inputs,
        stepRuntime,
        options.timeoutMs,
      );
      if (!result.ok) {
        const recovery = await failureRecovery(
          prepared,
          step,
          index,
          result,
          initialSnapshot,
          runtime,
        );
        const durationMs = performance.now() - startedAt;
        await runtime.report({ status: "failed", durationMs });
        return {
          status: "failed" as const,
          workflow: prepared.recipe.name,
          version: prepared.recipe.version,
          recovery,
        };
      }
      if (result.popupPage) popupPage = result.popupPage;
    }
    const durationMs = performance.now() - startedAt;
    const report = await runtime.report({ status: "success", durationMs });
    return {
      status: "success" as const,
      workflow: prepared.recipe.name,
      version: prepared.recipe.version,
      steps: prepared.recipe.steps.length,
      zeroLlm: true,
      durationMs: Math.round(durationMs),
      stats: (report as any)?.stats,
    };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    await runtime.report({ status: "failed", durationMs }).catch(() => undefined);
    return {
      status: "failed" as const,
      workflow: prepared.recipe.name,
      version: prepared.recipe.version,
      recovery: await failureRecovery(
        prepared,
        undefined,
        -1,
        { error },
        initialSnapshot,
        runtime,
      ),
    };
  }
}

async function executeStep(
  step: WorkflowStep,
  inputs: Record<string, unknown>,
  runtime: WorkflowReplayRuntime,
  defaultTimeoutMs = 20_000,
): Promise<
  | { ok: true; popupPage?: any }
  | {
      ok: false;
      error: unknown;
      candidates?: ResolvedTarget["candidates"];
    }
> {
  const traceId = `workflow-${randomUUID()}`;
  const startedAt = performance.now();
  let resolved: ResolvedTarget | undefined;
  runtime.trace?.({
    phase: "started",
    stepId: traceId,
    action: `workflow.${step.action}`,
    target: step.target
      ? { locator: step.target.locator, role: step.target.role, name: step.target.name }
      : { url: step.url, siteTool: step.siteTool?.toolName },
  });
  try {
    if (step.target) {
      resolved = await resolveTarget(step.target, runtime.page);
      if (!resolved) {
        throw new WorkflowTargetError("No unique workflow target", []);
      }
      await assertPreconditions(step.preconditions, resolved.locator, runtime.page);
    }
    const waiters = startWaiters(
      step.waits,
      runtime.page,
      defaultTimeoutMs,
    );
    await performAction(step, resolved?.locator, inputs, runtime);
    const waitResults = await Promise.all(waiters);
    await assertPostconditions(
      step.assertions,
      resolved?.locator,
      inputs,
      runtime.page,
    );
    runtime.trace?.({
      phase: "finished",
      stepId: traceId,
      action: `workflow.${step.action}`,
      status: "success",
      durationMs: performance.now() - startedAt,
    });
    const popupIndex = step.waits.findIndex((wait) => wait.kind === "popup");
    return {
      ok: true,
      popupPage: popupIndex >= 0 ? waitResults[popupIndex] : undefined,
    };
  } catch (error) {
    runtime.trace?.({
      phase: "finished",
      stepId: traceId,
      action: `workflow.${step.action}`,
      status: "failed",
      durationMs: performance.now() - startedAt,
      error: safeError(error),
    });
    return {
      ok: false,
      error,
      candidates:
        error instanceof WorkflowTargetError
          ? error.candidates
          : resolved?.candidates,
    };
  }
}

async function resolveTarget(
  target: WorkflowTarget,
  page: any,
): Promise<ResolvedTarget> {
  const candidates: ResolvedTarget["candidates"] = [];
  const attempts: Array<{ strategy: string; locator: string; create: () => any }> = [
    {
      strategy: "original-locator",
      locator: target.locator,
      create: () => page.locator(target.locator),
    },
  ];
  if (target.role && target.name) {
    attempts.push({
      strategy: "role-name",
      locator: `role:${target.role}[name=${JSON.stringify(target.name)}]`,
      create: () => page.getByRole(target.role, { name: target.name, exact: true }),
    });
  }
  if (target.label) {
    attempts.push({
      strategy: "label",
      locator: `label:${JSON.stringify(target.label)}`,
      create: () => page.getByLabel(target.label, { exact: true }),
    });
  }
  if (target.parent?.role && target.parent.name && target.role) {
    attempts.push({
      strategy: "parent-semantics",
      locator: `role:${target.parent.role}[name=${JSON.stringify(target.parent.name)}] >> role:${target.role}[name=${JSON.stringify(target.name ?? "")}]`,
      create: () =>
        page
          .getByRole(target.parent!.role, {
            name: target.parent!.name,
            exact: true,
          })
          .getByRole(target.role, {
            ...(target.name ? { name: target.name, exact: true } : {}),
          }),
    });
  }
  if (target.adjacent?.before) {
    attempts.push({
      strategy: "adjacent-before",
      locator: `text:${JSON.stringify(target.adjacent.before)} >> following-sibling::*[1]`,
      create: () =>
        page
          .getByText(target.adjacent!.before, { exact: true })
          .locator("xpath=following-sibling::*[1]"),
    });
  }
  if (target.adjacent?.after) {
    attempts.push({
      strategy: "adjacent-after",
      locator: `text:${JSON.stringify(target.adjacent.after)} >> preceding-sibling::*[1]`,
      create: () =>
        page
          .getByText(target.adjacent!.after, { exact: true })
          .locator("xpath=preceding-sibling::*[1]"),
    });
  }
  if (
    target.selfHealLocator &&
    target.selfHealLocator !== target.locator
  ) {
    attempts.push({
      strategy: "unique-self-heal",
      locator: target.selfHealLocator,
      create: () => page.locator(target.selfHealLocator),
    });
  }

  const seen = new Set<string>();
  for (const attempt of attempts) {
    const key = `${attempt.strategy}:${attempt.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const locator = attempt.create();
      const count = await locator.count();
      candidates.push({
        strategy: attempt.strategy,
        locator: attempt.locator,
        count,
      });
      if (count === 1) {
        return { locator, strategy: attempt.strategy, candidates };
      }
    } catch (error) {
      candidates.push({
        strategy: attempt.strategy,
        locator: attempt.locator,
        error: safeError(error),
      });
    }
  }
  throw new WorkflowTargetError(
    candidates.some((candidate) => (candidate.count ?? 0) > 1)
      ? "Workflow target is ambiguous; replay stopped without guessing"
      : "Workflow target was not found",
    candidates,
  );
}

async function performAction(
  step: WorkflowStep,
  locator: any,
  inputs: Record<string, unknown>,
  runtime: WorkflowReplayRuntime,
) {
  switch (step.action) {
    case "goto":
      return runtime.page.goto(interpolate(step.url ?? "", inputs), {
        waitUntil: "domcontentloaded",
      });
    case "click":
      return locator.click();
    case "dblclick":
      return locator.dblclick();
    case "fill":
    case "secretFill":
      return locator.fill(String(resolveStepValue(step, inputs)));
    case "press":
      return step.target
        ? locator.press(step.key ?? "")
        : runtime.page.keyboard.press(step.key ?? "");
    case "check":
      return locator.check();
    case "uncheck":
      return locator.uncheck();
    case "selectOption":
      return locator.selectOption(resolveStepValue(step, inputs));
    case "site.runTool":
      assertSiteTool(runtime, step);
      return runtime.site.runTool(
        step.siteTool!.siteId,
        step.siteTool!.toolName,
        resolveTemplateObject(step.siteTool!.args, inputs),
      );
    case "site.runBrowserTool":
      assertSiteTool(runtime, step);
      return runtime.site.runBrowserTool(
        step.siteTool!.siteId,
        step.siteTool!.toolName,
        resolveTemplateObject(step.siteTool!.args, inputs),
      );
  }
}

function startWaiters(waits: WorkflowWait[], page: any, defaultTimeoutMs: number) {
  return waits.map((wait) => {
    const timeout = finiteTimeout(wait.timeoutMs, defaultTimeoutMs);
    if (wait.kind === "popup" || wait.kind === "download") {
      return page.waitForEvent(wait.kind, { timeout });
    }
    if (wait.kind === "navigation") {
      const expected = wait.urlContains ?? "";
      return page.waitForURL(
        (url: URL) => String(url).includes(expected),
        { timeout, waitUntil: "domcontentloaded" },
      );
    }
    return waitForDialog(page, wait, timeout);
  });
}

async function waitForDialog(page: any, wait: WorkflowWait, timeout: number) {
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    const info = await page.info().catch(() => undefined);
    if (
      info?.dialog &&
      (!wait.dialogType || info.dialog.type === wait.dialogType)
    ) {
      return info.dialog;
    }
    await page.waitForTimeout(Math.min(50, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`workflow dialog wait timed out after ${timeout}ms`);
}

async function assertPreconditions(
  conditions: WorkflowCondition[],
  locator: any,
  page: any,
) {
  for (const condition of conditions) {
    if (condition.kind === "targetUnique") {
      const count = await locator.count();
      if (count !== 1) throw new Error(`expected one target, found ${count}`);
    } else if (condition.kind === "targetVisible") {
      if (!(await locator.isVisible())) {
        throw new Error("workflow target is not visible");
      }
    } else if (condition.kind === "urlContains") {
      const url = await page.url();
      if (!String(url).includes(condition.value ?? "")) {
        throw new Error("workflow URL precondition failed");
      }
    }
  }
}

async function assertPostconditions(
  conditions: WorkflowCondition[],
  locator: any,
  inputs: Record<string, unknown>,
  page: any,
) {
  for (const condition of conditions) {
    if (condition.kind === "inputMatches") {
      const expected = condition.slot
        ? inputs[condition.slot.name]
        : condition.value;
      if (String(await locator.inputValue()) !== String(expected ?? "")) {
        throw new Error("workflow input assertion failed");
      }
    } else if (condition.kind === "checked") {
      if ((await locator.isChecked()) !== (condition.value === "true")) {
        throw new Error("workflow checked-state assertion failed");
      }
    } else if (condition.kind === "urlContains") {
      const url = await page.url();
      if (!String(url).includes(condition.value ?? "")) {
        throw new Error("workflow URL assertion failed");
      }
    }
  }
}

async function requiredApproval(
  step: WorkflowStep,
  options: WorkflowReplayOptions,
  page: any,
) {
  if (!step.risk || step.risk.level !== "high") return undefined;
  const approval = options.approval;
  const currentUrl = await page.url().catch(() => "");
  const domain = hostname(currentUrl) ?? step.risk.domain;
  const domainAllowed =
    Boolean(domain) &&
    Array.isArray(approval?.domains) &&
    approval!.domains!.some(
      (allowed) => allowed === domain || domain!.endsWith(`.${allowed}`),
    );
  const actionAllowed =
    Array.isArray(approval?.actions) &&
    approval!.actions!.includes(step.risk.action);
  if (approval?.highRisk === true && domainAllowed && actionAllowed) {
    return undefined;
  }
  return {
    level: "high" as const,
    domain,
    action: step.risk.action,
    reason: step.risk.reason,
    policy: {
      highRisk: true,
      domains: domain ? [domain] : [],
      actions: [step.risk.action],
    },
  };
}

async function failureRecovery(
  prepared: PreparedWorkflow,
  step: WorkflowStep | undefined,
  stepIndex: number,
  result: { error: unknown; candidates?: ResolvedTarget["candidates"] },
  initialSnapshot: any,
  runtime: WorkflowReplayRuntime,
) {
  const snapshot = await runtime.page
    .snapshot({
      format: "structured",
      interactive: true,
      compact: true,
      ...(typeof initialSnapshot?.revision === "string" &&
      initialSnapshot.revision.length > 0
        ? { sinceRevision: initialSnapshot.revision }
        : {}),
    })
    .catch((error: unknown) => ({
      kind: "unavailable",
      error: safeError(error),
    }));
  const events = runtime.listEvents
    ? await runtime
        .listEvents(prepared.startSequence, {
          categories: [
            "navigation",
            "network",
            "console",
            "dialog",
            "download",
            "lifecycle",
          ],
          limit: 100,
        })
        .catch((error: unknown) => ({
          events: [],
          error: safeError(error),
        }))
    : { events: [] };
  const screenshot = await runtime.page
    .screenshot({})
    .catch(() => undefined);
  return {
    failedStep: step
      ? { index: stepIndex, id: step.id, action: step.action }
      : { index: stepIndex, action: "workflow" },
    expectedTarget: step?.target,
    currentCandidates: result.candidates ?? [],
    error: safeError(result.error),
    snapshotDelta: snapshot,
    journalEvents: events?.events ?? [],
    screenshot,
  };
}

function resolveInputs(recipe: WorkflowRecipe, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("workflow replay inputs must be an object");
  }
  const raw = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const slot of recipe.variables) {
    if (!Object.prototype.hasOwnProperty.call(raw, slot.name)) {
      throw new Error(`EGO_WORKFLOW_VARIABLE_REQUIRED: ${slot.name}`);
    }
    const input = raw[slot.name];
    output[slot.name] = isSecret(input) ? input.value : input;
  }
  for (const slot of recipe.secrets) {
    const input = raw[slot.name];
    if (!isSecret(input)) {
      throw new Error(
        `EGO_WORKFLOW_SECRET_REQUIRED: wrap ${slot.name} with secret(...)`,
      );
    }
    output[slot.name] = input.value;
  }
  return output;
}

function resolveStepValue(step: WorkflowStep, inputs: Record<string, unknown>) {
  if (!step.value) return "";
  return step.value.kind === "literal"
    ? step.value.value
    : inputs[step.value.name];
}

function resolveTemplateObject(value: unknown, inputs: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateObject(item, inputs));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      (record.slot === "variable" || record.slot === "secret") &&
      typeof record.name === "string"
    ) {
      return inputs[record.name];
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [
        key,
        resolveTemplateObject(child, inputs),
      ]),
    );
  }
  return value;
}

function interpolate(template: string, inputs: Record<string, unknown>) {
  let output = template;
  for (const [name, value] of Object.entries(inputs)) {
    const raw = `\${${name}}`;
    const encoded = encodeURIComponent(raw);
    output = output.split(raw).join(encodeURIComponent(String(value ?? "")));
    output = output
      .split(encoded)
      .join(encodeURIComponent(String(value ?? "")));
  }
  return output;
}

function assertSiteTool(runtime: WorkflowReplayRuntime, step: WorkflowStep) {
  if (!runtime.site || !step.siteTool) {
    throw new Error("EGO_WORKFLOW_SITE_TOOL_UNAVAILABLE");
  }
}

function isSecret(value: unknown): value is SecretValue {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).__ufoWorkflowSecret === true,
  );
}

function hostname(value: unknown) {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return undefined;
  }
}

function finiteTimeout(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(password|secret|token|otp|pin)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 2_048);
}

class WorkflowTargetError extends Error {
  constructor(
    message: string,
    readonly candidates: ResolvedTarget["candidates"],
  ) {
    super(message);
    this.name = "WorkflowTargetError";
  }
}

export const __testing = {
  resolveTarget,
  requiredApproval,
  resolveInputs,
  interpolate,
};
