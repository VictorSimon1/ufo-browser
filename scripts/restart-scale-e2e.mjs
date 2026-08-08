import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const testNamespace = "restart-scale";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
const userData = join(testRoot, "user-data");
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
const electron = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

await execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")]);
await rm(testRoot, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(
  join(userData, "browser-state.json"),
  `${JSON.stringify(seedState(64), null, 2)}\n`,
  { mode: 0o600 },
);

const launchedAt = Date.now();
const child = spawn(electron, ["."], {
  cwd: root,
  env: {
    ...process.env,
    X_BROWSER_TEST_APP: "1",
    X_BROWSER_TEST_OVERVIEW_STRESS_SCROLL: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
  if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
});

try {
  const startup = await freshJson("preview-state.json", 9_000);
  const startupReady =
    startup.renderer?.canvases?.filter((canvas) => canvas.ready).length ?? 0;
  const startupVisible = startup.main?.visibleSpaceIds?.length ?? 0;
  if (
    startupReady < Math.min(4, startupVisible) ||
    startupVisible < 1 ||
    startupVisible > 8 ||
    startup.renderer?.previewError
  ) {
    throw new Error("large-space startup did not paint a useful first viewport");
  }

  const diagnostics = await waitForDiagnostics(
    (state) => {
      const activeRuntimes =
        state.runtimes?.filter((runtime) => runtime.runtime) ?? [];
      return (
        Number(state.cacheBudget?.evictions || 0) > 0 &&
        Math.max(...(state.visibleSpaceIds || [0])) >= 64 &&
        (state.captures?.length ?? 0) === 0 &&
        (state.coldCaptures?.length ?? 0) === 0 &&
        activeRuntimes.length <= 8
      );
    },
    45_000,
  );
  const runtimes = diagnostics.runtimes?.filter((runtime) => runtime.runtime) ?? [];
  const hiddenSurfaces = runtimes.filter((runtime) => runtime.backgroundSurface);
  const result = {
    spaces: diagnostics.runtimes?.reduce(
      (ids, runtime) => ids.add(runtime.spaceId),
      new Set(),
    ).size,
    startupVisible,
    startupReady,
    visible: diagnostics.visibleSpaceIds?.length ?? 0,
    highestVisibleSpaceId: Math.max(...(diagnostics.visibleSpaceIds || [0])),
    runtimes: runtimes.length,
    hiddenSurfaces: hiddenSurfaces.length,
    captures: diagnostics.captures?.length ?? 0,
    coldCaptures: diagnostics.coldCaptures?.length ?? 0,
    cacheBudget: diagnostics.cacheBudget,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    result.spaces !== 64 ||
    result.visible < 1 ||
    result.visible > 8 ||
    result.highestVisibleSpaceId !== 64 ||
    result.runtimes > 8 ||
    result.hiddenSurfaces > 1 ||
    result.captures > 2 ||
    result.coldCaptures > 1 ||
    result.cacheBudget.entries > result.cacheBudget.maxEntries ||
    result.cacheBudget.bytes > result.cacheBudget.maxBytes ||
    result.cacheBudget.evictions < 1
  ) {
    throw new Error("large-space recovery exceeded its resource budget");
  }
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  child.kill("SIGTERM");
  await execFileAsync(process.execPath, [join(root, "scripts/stop-test-app.mjs")]).catch(
    () => undefined,
  );
}

function seedState(count) {
  const now = Date.now();
  return {
    version: 1,
    nextSpaceId: count + 1,
    spaces: Array.from({ length: count }, (_, index) => {
      const id = index + 1;
      const targetId = `scale-space-${String(id).padStart(3, "0")}`;
      const agentOwned = id % 2 === 1;
      return {
        id,
        taskId: `Scale Space ${id}`,
        name: `Scale Space ${id}`,
        createdBy: agentOwned ? "agent" : "user",
        ownership: agentOwned ? "agent" : "user",
        lifecycle: "active",
        profileId: "default",
        tabs: [
          {
            targetId,
            url: "x-browser://newtab/",
            title: "New Tab",
            createdAt: now + id,
          },
        ],
        activeTabId: targetId,
        agentTask: agentOwned
          ? {
              title: `Scale Space ${id}`,
              detail: "Agent background preview stress",
              completed: 0,
              total: 1,
              updatedAt: now + id,
            }
          : undefined,
        createdAt: now + id,
        updatedAt: now + id,
      };
    }),
  };
}

async function freshJson(name, timeoutMs) {
  const path = join(testRoot, name);
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs >= launchedAt - 250) {
        return JSON.parse(await readFile(path, "utf8"));
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timed out waiting for fresh ${name}: ${lastError || "not written"}`);
}

async function waitForDiagnostics(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await freshJson("preview-main-live.json", 600);
      if (predicate(latest)) return latest;
    } catch {
      // The diagnostics writer may be between its atomic truncate/write steps.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(
    `timed out waiting for bounded scale recovery: ${JSON.stringify(latest?.cacheBudget)}`,
  );
}
