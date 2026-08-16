import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { helperContext } from "../agent/runtime/helpers.js";
import { setOverrides } from "../agent/runtime/state.js";

test("learned Node and browser tools execute through the public site facade", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ufo-browser-learning-"));
  const siteDir = join(workspace, "learnings", "fixture-site");
  await mkdir(join(siteDir, "tools"), { recursive: true });
  await mkdir(join(siteDir, "browser-tools"), { recursive: true });
  await writeFile(
    join(siteDir, "manifest.json"),
    JSON.stringify({
      id: "fixture-site",
      name: "Fixture Site",
      domains: ["fixture.local"],
      notes: [],
      nodeTools: {
        echo: {
          description: "Return a value through the Node helper context.",
          path: "tools/echo.js",
          callable: "echo",
          args: {
            value: {
              type: "string",
              required: true,
              description: "Value to echo.",
            },
          },
          returns: { type: "object", description: "Echo result." },
        },
      },
      browserTools: {
        inspect: {
          description: "Return browser-tool arguments.",
          path: "browser-tools/inspect.js",
          args: {
            value: {
              type: "string",
              required: true,
              description: "Value to inspect.",
            },
          },
          returns: { type: "object", description: "Browser result." },
        },
      },
    }),
  );
  await writeFile(
    join(siteDir, "tools", "echo.js"),
    "export async function echo(ctx, args) { return { value: args.value, hasPage: typeof ctx.page?.locator === 'function' }; }\n",
  );
  await writeFile(
    join(siteDir, "browser-tools", "inspect.js"),
    "async (args) => ({ value: args.value, runtime: 'browser' })\n",
  );

  const restore = setOverrides({
    agentWorkspace: () => workspace,
    cdpOverride: async (method: string, params: { expression: string }) => {
      assert.equal(method, "Runtime.evaluate");
      const value = await (0, eval)(params.expression);
      return { result: { value } };
    },
  });
  try {
    const context = helperContext();
    const learned = await context.site.learnContext("https://fixture.local/path");
    assert.equal(learned.exists, true);
    assert.deepEqual(
      learned.tools
        .map((tool: { toolType: string; toolName: string }) =>
          `${tool.toolType}:${tool.toolName}`,
        )
        .sort(),
      ["browser:inspect", "node:echo"],
    );
    assert.deepEqual(
      await context.site.runTool("fixture-site", "echo", { value: "node-ok" }),
      { value: "node-ok", hasPage: true },
    );
    assert.deepEqual(
      await context.site.runBrowserTool("fixture-site", "inspect", {
        value: "browser-ok",
      }),
      { value: "browser-ok", runtime: "browser" },
    );
  } finally {
    restore();
    await rm(workspace, { recursive: true, force: true });
  }
});
