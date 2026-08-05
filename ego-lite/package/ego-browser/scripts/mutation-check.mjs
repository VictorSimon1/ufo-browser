#!/usr/bin/env node
/**
 * Lightweight mutation testing for ego-browser.
 *
 * Parses compiled JS in dist/src/ with acorn, injects targeted mutations
 * (operator flips, return value swaps, boundary shifts), runs the
 * corresponding test file, and reports kill rate.
 *
 * Usage:
 *   node scripts/mutation-check.mjs                    # check all modules
 *   node scripts/mutation-check.mjs cdp-eval           # check one module
 *   node scripts/mutation-check.mjs --verbose           # print each mutant
 *
 * Requires: npm run build (to produce dist/ output).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import * as acorn from "acorn";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, "..");
const DIST_SRC = join(PKG_DIR, "dist", "src");

/* ── module → test file mapping ── */
const MODULE_MAP = {
  "cdp-eval": {
    src: "cdp-eval.js",
    test: "src/cdp-eval.test.mjs",
    focus: [
      "hasReturnStatement",
      "decodeUnserializableJsValue",
      "runtimeValue",
    ],
  },
  "element-resolver": {
    src: "element-resolver.js",
    test: "src/element-resolver.test.mjs",
    focus: [
      "matchCountKind",
      "boxModelCenter",
      "isStaleBackendNodeError",
      "isBoxModelUnavailableError",
    ],
  },
  "browser-runtime": {
    src: "browser-runtime.js",
    test: "src/browser-runtime.test.mjs",
    focus: ["ensureSession", "handleMessage"],
  },
  helpers: {
    src: "helpers.js",
    test: "src/helpers.test.mjs",
    focus: ["isAgentOwned", "findMatchingTaskSpace"],
  },
};

/* ── mutation operators ── */
const BINARY_FLIPS = {
  "===": "!==",
  "!==": "===",
  "==": "!=",
  "!=": "==",
  ">": "<=",
  "<": ">=",
  ">=": "<",
  "<=": ">",
  "&&": "||",
  "||": "&&",
};

const ARITHMETIC_FLIPS = {
  "+": "-",
  "-": "+",
  "*": "/",
};

const RETURN_VALUE_SWAPS = [
  { from: "true", to: "false" },
  { from: "false", to: "true" },
  { from: "null", to: "undefined" },
  { from: "0", to: "1" },
  { from: "1", to: "0" },
];

/* ── AST walker ── */
function walk(node, visitors) {
  if (!node || typeof node !== "object") return;
  const visit = visitors[node.type];
  if (visit) visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc")
      continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visitors);
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitors);
    }
  }
}

/* ── mutation candidate collection ── */
function collectMutations(source, focusFunctions) {
  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 2022,
      sourceType: "module",
      locations: true,
    });
  } catch {
    return [];
  }

  const mutations = [];

  walk(ast, {
    BinaryExpression(node) {
      if (!inFocus(source, node.start, focusFunctions)) return;
      const op = node.operator;
      if (BINARY_FLIPS[op]) {
        const original = source.slice(node.start, node.end);
        const mutated = original.replace(op, BINARY_FLIPS[op]);
        mutations.push({
          type: `binary:${op}→${BINARY_FLIPS[op]}`,
          start: node.start,
          end: node.end,
          original,
          mutated,
          line: node.loc?.start?.line,
        });
      }
      if (ARITHMETIC_FLIPS[op] && !isStringContext(source, node)) {
        const original = source.slice(node.start, node.end);
        const mutated = original.replace(op, ARITHMETIC_FLIPS[op]);
        mutations.push({
          type: `arith:${op}→${ARITHMETIC_FLIPS[op]}`,
          start: node.start,
          end: node.end,
          original,
          mutated,
          line: node.loc?.start?.line,
        });
      }
    },
    ReturnStatement(node) {
      if (!inFocus(source, node.start, focusFunctions)) return;
      if (!node.argument) return;
      const argSrc = source
        .slice(node.argument.start, node.argument.end)
        .trim();
      for (const swap of RETURN_VALUE_SWAPS) {
        if (argSrc === swap.from) {
          mutations.push({
            type: `return:${swap.from}→${swap.to}`,
            start: node.argument.start,
            end: node.argument.end,
            original: argSrc,
            mutated: swap.to,
            line: node.loc?.start?.line,
          });
          break;
        }
      }
    },
    UnaryExpression(node) {
      if (!inFocus(source, node.start, focusFunctions)) return;
      if (node.operator === "!" && node.argument.type === "Identifier") {
        mutations.push({
          type: "negate:!x→x",
          start: node.start,
          end: node.end,
          original: source.slice(node.start, node.end),
          mutated: source.slice(node.argument.start, node.argument.end),
          line: node.loc?.start?.line,
        });
      }
    },
  });

  return deduplicateMutations(mutations);
}

function inFocus(source, offset, focusFunctions) {
  if (!focusFunctions || focusFunctions.length === 0) return true;
  // Check if the offset is inside a function whose name is in the focus list.
  // Simple heuristic: scan backward from offset for a function declaration/export
  // containing one of the focus names.
  const before = source.slice(Math.max(0, offset - 2000), offset);
  for (const name of focusFunctions) {
    // Match both `function name(` and `async function name(` and `export function name(`
    const pattern = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`,
    );
    if (pattern.test(before)) return true;
    // Also match arrow functions: `const name = ... =>`
    const arrowPattern = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`);
    if (arrowPattern.test(before)) return true;
  }
  return false;
}

function isStringContext(source, node) {
  // Skip arithmetic flips that look like string concatenation
  return node.left?.type === "Literal" && typeof node.left.value === "string";
}

function deduplicateMutations(mutations) {
  const seen = new Set();
  return mutations.filter((m) => {
    const key = `${m.start}:${m.end}:${m.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ── mutation application ── */
function applyMutation(source, mutation) {
  return (
    source.slice(0, mutation.start) +
    mutation.mutated +
    source.slice(mutation.end)
  );
}

/* ── test runner ── */
function runTest(testFile, timeoutMs = 15000) {
  try {
    execSync(`node --test "${testFile}"`, {
      cwd: PKG_DIR,
      timeout: timeoutMs,
      stdio: "pipe",
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    return { passed: true };
  } catch (error) {
    return {
      passed: false,
      output: error.stderr?.toString().slice(-500) || "",
    };
  }
}

/* ── main ── */
function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const targetModules = args.filter((a) => !a.startsWith("--"));

  const modules =
    targetModules.length > 0
      ? Object.fromEntries(
          targetModules
            .filter((m) => MODULE_MAP[m])
            .map((m) => [m, MODULE_MAP[m]]),
        )
      : MODULE_MAP;

  if (Object.keys(modules).length === 0) {
    console.error(
      "No matching modules found. Available:",
      Object.keys(MODULE_MAP).join(", "),
    );
    process.exit(1);
  }

  // Check that dist/ exists
  if (!existsSync(DIST_SRC)) {
    console.error("dist/src/ not found. Run `npm run build` first.");
    process.exit(1);
  }

  const report = [];
  let totalMutations = 0;
  let totalKilled = 0;
  let totalSurvived = 0;
  let totalSkipped = 0;

  for (const [moduleName, config] of Object.entries(modules)) {
    const srcPath = join(DIST_SRC, config.src);
    if (!existsSync(srcPath)) {
      console.error(`  [skip] ${config.src} not found in dist/src/`);
      totalSkipped++;
      continue;
    }

    const source = readFileSync(srcPath, "utf-8");
    const mutations = collectMutations(source, config.focus);

    if (mutations.length === 0) {
      console.log(`  [${moduleName}] no mutation candidates found`);
      continue;
    }

    console.log(`\n[${moduleName}] ${mutations.length} mutations to test`);

    const moduleResults = [];
    let killed = 0;
    let survived = 0;

    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      const mutated = applyMutation(source, m);

      // Backup original
      writeFileSync(srcPath, mutated, "utf-8");
      try {
        const result = runTest(config.test);
        const status = result.passed ? "SURVIVED" : "KILLED";

        if (result.passed) {
          survived++;
          totalSurvived++;
        } else {
          killed++;
          totalKilled++;
        }

        moduleResults.push({ ...m, status });

        if (verbose || status === "SURVIVED") {
          const marker = status === "KILLED" ? "✗" : "✓";
          console.log(`  ${marker} L${m.line || "?"} ${m.type} — ${status}`);
        }

        const pct = Math.round(((i + 1) / mutations.length) * 100);
        process.stdout.write(`  ${i + 1}/${mutations.length} (${pct}%)\r`);
      } finally {
        // Always restore original
        writeFileSync(srcPath, source, "utf-8");
      }
    }

    totalMutations += mutations.length;

    const killRate =
      mutations.length > 0 ? Math.round((killed / mutations.length) * 100) : 0;
    report.push({
      module: moduleName,
      total: mutations.length,
      killed,
      survived,
      killRate,
      survivedMutations: moduleResults.filter((r) => r.status === "SURVIVED"),
    });
  }

  // ── Summary ──
  console.log("\n" + "═".repeat(60));
  console.log("MUTATION TESTING REPORT");
  console.log("═".repeat(60));

  for (const r of report) {
    const bar =
      "█".repeat(Math.round(r.killRate / 5)) +
      "░".repeat(20 - Math.round(r.killRate / 5));
    const indicator =
      r.killRate >= 80 ? "OK" : r.killRate >= 60 ? "WARN" : "LOW";
    console.log(`\n  ${r.module}:`);
    console.log(
      `    ${bar} ${r.killRate}% (${r.killed}/${r.total} killed) [${indicator}]`,
    );

    if (r.survivedMutations.length > 0 && r.survivedMutations.length <= 10) {
      console.log("    Survived mutations:");
      for (const s of r.survivedMutations) {
        console.log(
          `      L${s.line || "?"} ${s.type}: ${s.original.trim().slice(0, 60)}`,
        );
      }
    } else if (r.survivedMutations.length > 10) {
      console.log(
        `    ${r.survivedMutations.length} survived mutations (use --verbose for details)`,
      );
    }
  }

  const overallRate =
    totalMutations > 0 ? Math.round((totalKilled / totalMutations) * 100) : 0;
  console.log(`\n${"─".repeat(60)}`);
  console.log(
    `  Overall: ${totalKilled}/${totalMutations} killed (${overallRate}%)`,
  );
  console.log(`  ${totalSurvived} survived, ${totalSkipped} skipped`);
  console.log("═".repeat(60));

  if (overallRate < 60) {
    console.log("\n  Kill rate below 60% — consider strengthening assertions.");
    process.exit(1);
  }
}

main();
