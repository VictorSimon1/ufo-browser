import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflowUrl = new URL(
  "../../../.github/workflows/publish-ego-browser-skill.yml",
  import.meta.url,
);

test("publishes ego-browser to ClawHub and SkillHub from an exact SemVer tag", () => {
  assert.equal(existsSync(workflowUrl), true, "publish workflow must exist");

  const workflow = readFileSync(fileURLToPath(workflowUrl), "utf8");

  assert.match(
    workflow,
    /tags:\s*\n\s*- ['"]\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+['"]/,
  );
  assert.match(workflow, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(workflow, /CLAWHUB_TOKEN:\s*\$\{\{ secrets\.CLAWHUB_TOKEN \}\}/);
  assert.match(
    workflow,
    /SKILLHUB_TOKEN:\s*\$\{\{ secrets\.SKILLHUB_TOKEN \}\}/,
  );
  assert.match(
    workflow,
    /npm ci[\s\S]*npm test[\s\S]*npm run validate:site-skills/,
  );
  assert.match(workflow, /clawhub@0\.21\.0[\s\S]*skill publish/);
  assert.match(workflow, /SKILLHUB_CLI_SHA256:\s*[a-f0-9]{64}/);
  assert.match(workflow, /sha256sum --check/);
  assert.match(workflow, /^\s+SKILLHUB_SLUG: ego-browser$/m);
  assert.doesNotMatch(workflow, /ego-browser-user-/);
  assert.match(workflow, /skillhub publish[\s\S]*--dry-run/);
  assert.match(workflow, /skillhub publish[\s\S]*--version "\$VERSION"/);
  assert.match(workflow, /skills\/ego-browser/);
});
