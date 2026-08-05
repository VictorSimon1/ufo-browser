import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { help, formatHelp } from "../dist/src/help-runtime.js";

// Regression test for GitHub issue #84: the runtime used to build its docs map
// by reading its own source, which produced an empty map whenever the SDK was
// not loaded from a real file (the shipped .pak resource). Docs are now
// embedded at build time, so these assertions exercise the injected data.

test("help(name) returns the embedded doc instead of an empty result", () => {
  const doc = help({ click: () => {} }, "click");
  assert.equal(typeof doc, "object");
  assert.equal(doc.name, "click");
  assert.ok(
    doc.description && doc.description.length > 0,
    `expected a non-empty description, got: ${JSON.stringify(doc)}`,
  );
});

test("help() lists the helpers present in the context", () => {
  const list = help({ click: () => {}, waitFor: () => {} });
  assert.ok(Array.isArray(list));
  assert.ok(list.length > 0, "expected embedded docs to be non-empty");
  assert.ok(list.some((d) => d.name === "click"));
});

test("help(unknown) reports the unknown helper", () => {
  assert.equal(
    help({}, "definitelyNotAHelper"),
    "Unknown helper: definitelyNotAHelper",
  );
});

test("formatHelp renders the signature for an embedded doc", () => {
  const doc = help({ click: () => {} }, "click");
  const text = formatHelp(doc);
  assert.ok(text.includes("click("), `expected signature in:\n${text}`);
});

test("help works when the shipped bundle runs as an eval module", () => {
  // The app executes the SDK from an in-memory string, so its import.meta.url
  // ("file:///...[eval1]") is not a readable file — the exact condition that
  // broke the old self-introspection. Feed the real dist/out bundle to node
  // the same way and query help through the installed global, like an agent
  // script (a separate eval module sharing only globals) would. The file://
  // imports above cannot catch a regression of this class.
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const bundle = readFileSync(join(root, "dist", "out", "index.js"), "utf-8");
  // globalThis, not a bare identifier: appended source shares the bundle's
  // module scope, where the raw help(helpers, ...names) export would shadow
  // the installed global wrapper.
  const probe = 'console.log(globalThis.help("click"))';
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    input: `${bundle}\n${probe}\n`,
    encoding: "utf-8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    !result.stdout.includes("Unknown helper"),
    `docs map was empty under eval loading:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("click("),
    `expected the click signature in:\n${result.stdout}`,
  );
});
