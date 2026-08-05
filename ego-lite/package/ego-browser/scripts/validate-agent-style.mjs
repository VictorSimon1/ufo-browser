import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));

const paths = [
  join(packageRoot, "README.md"),
  join(repoRoot, "skills/ego-browser/SKILL.md"),
  ...listFiles(join(repoRoot, "skills/ego-browser/learnings"), ".md"),
  ...listFiles(join(packageRoot, "scripts/real-browser-e2e/cases"), ".mjs"),
];

const failures = [];

for (const file of paths) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, "utf8");
  const rel = relative(repoRoot, file);
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    if (line.includes("agent-style-ok")) continue;

    if (
      /\bpage\.mouse\.click\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?/.test(line)
    ) {
      failures.push(
        `${rel}:${lineNo} avoid fixed coordinate page.mouse.click; prefer locator clicks`,
      );
    }

    const waitMatch = /\bpage\.waitForTimeout\(\s*(\d+)/.exec(line);
    if (waitMatch && Number(waitMatch[1]) >= 1000) {
      failures.push(
        `${rel}:${lineNo} avoid long fixed page.waitForTimeout; prefer locator/page waits`,
      );
    }

    if (/\bpage\.locator\(\s*["']text=/.test(line) && !/compat/i.test(line)) {
      failures.push(
        `${rel}:${lineNo} prefer page.getByText(...) over page.locator("text=...")`,
      );
    }
  }

  if (
    (rel.endsWith(".md") || rel.endsWith("README.md")) &&
    /page\.evaluate\(String\.raw/.test(content) &&
    /document\.querySelectorAll/.test(content)
  ) {
    failures.push(
      `${rel}: prefer locator.extractAll/evaluateAll over page.evaluate(String.raw + querySelectorAll) in agent-facing docs`,
    );
  }
}

if (failures.length) {
  console.error("Agent style validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Agent style validation passed (${paths.length} files).`);

function listFiles(root, extension) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFiles(fullPath, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      result.push(fullPath);
    }
  }
  return result;
}
