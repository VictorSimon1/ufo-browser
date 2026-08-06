import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  MANAGED_MARKER,
  syncAgentSkills,
} from "./sync-agent-skills.mjs";

test("managed Agent Skills install atomically, remain current, and repair drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-skill-sync-managed-"));
  try {
    const skillsRoot = join(root, "agent", "skills");
    const target = {
      id: "test-agent",
      label: "Test Agent",
      skillsRoot,
      explicit: true,
    };
    const sourceRoot = resolve("skills/ufo-browser");
    const first = await syncAgentSkills({ sourceRoot, targets: [target] });
    assert.equal(first.results[0].status, "installed");
    const marker = JSON.parse(
      await readFile(
        join(skillsRoot, "ufo-browser", MANAGED_MARKER),
        "utf8",
      ),
    );
    assert.equal(marker.sourceHash, first.sourceHash);

    const second = await syncAgentSkills({ sourceRoot, targets: [target] });
    assert.equal(second.results[0].status, "current");

    await writeFile(
      join(skillsRoot, "ufo-browser", "references/api.md"),
      "drift",
    );
    const repaired = await syncAgentSkills({ sourceRoot, targets: [target] });
    assert.equal(repaired.results[0].status, "updated");
    assert.notEqual(
      await readFile(
        join(skillsRoot, "ufo-browser", "references/api.md"),
        "utf8",
      ),
      "drift",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unmanaged same-name Skills are preserved unless force is explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ufo-skill-sync-unmanaged-"));
  try {
    const skillsRoot = join(root, "agent", "skills");
    const targetRoot = join(skillsRoot, "ufo-browser");
    await mkdir(targetRoot, { recursive: true });
    await writeFile(join(targetRoot, "custom.txt"), "keep");
    const summary = await syncAgentSkills({
      sourceRoot: resolve("skills/ufo-browser"),
      targets: [
        {
          id: "test-agent",
          label: "Test Agent",
          skillsRoot,
          explicit: true,
        },
      ],
    });
    assert.equal(summary.results[0].reason, "unmanaged-target");
    assert.equal(await readFile(join(targetRoot, "custom.txt"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
