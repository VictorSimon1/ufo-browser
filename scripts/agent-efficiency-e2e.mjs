import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const snapshot = JSON.parse(
  await run(process.execPath, ["scripts/snapshot-delta-e2e.mjs"]),
);
const workflow = JSON.parse(
  await run(process.execPath, ["scripts/workflow-replay-e2e.mjs"]),
);

assert.equal(snapshot.ok, true);
assert.equal(snapshot.deltaKind, "delta");
assert.ok(snapshot.deltaBytes < snapshot.fullBytes);
assert.ok(snapshot.deltaMs < snapshot.fullMs);
assert.equal(workflow.ok, true);
assert.equal(workflow.zeroLlmSecondRun, true);
assert.ok(workflow.steps > 0);

const result = {
  ok: true,
  snapshot: {
    fullBytes: snapshot.fullBytes,
    compactBytes: snapshot.compactBytes,
    deltaBytes: snapshot.deltaBytes,
    byteReductionPercent: round(
      (1 - snapshot.deltaBytes / snapshot.fullBytes) * 100,
    ),
    fullMs: round(snapshot.fullMs),
    deltaMs: round(snapshot.deltaMs),
    latencyReductionPercent: round(
      (1 - snapshot.deltaMs / snapshot.fullMs) * 100,
    ),
  },
  workflow: {
    steps: workflow.steps,
    firstRunAgentActionRounds: workflow.steps,
    secondRunAgentCommandRounds: 1,
    externalLlmCallsOnReplay: 0,
    zeroLlmSecondRun: workflow.zeroLlmSecondRun,
    recoveredByRoleName: workflow.recoveredByRoleName,
    persistedSecrets: workflow.persistedSecrets,
    stats: workflow.stats,
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

