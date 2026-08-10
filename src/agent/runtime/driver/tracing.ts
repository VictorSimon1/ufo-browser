// @ts-nocheck
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cdp } from "../cdp-eval.js";
import {
  ensureSession,
  subscribeBrowserEvent,
} from "../browser-runtime.js";
import { state } from "../state.js";

let activeTrace: { sessionId: string } | null = null;
let traceSequence = 0;

/** Start an explicit Chromium performance trace for the current page. */
export async function startTracing(options: any = {}) {
  if (activeTrace) throw new Error("page.tracing.start: a trace is already active");
  const sessionId = await ensureSession();
  const categories = normalizeCategories(options.categories, options.screenshots);
  const bufferUsageReportingInterval = finiteNonNegativeNumber(
    options.bufferUsageReportingInterval ?? 1000,
    "page.tracing.start options.bufferUsageReportingInterval",
  );
  const params: any = {
    transferMode: "ReturnAsStream",
    bufferUsageReportingInterval,
  };
  if (options.traceConfig) params.traceConfig = options.traceConfig;
  else params.categories = categories.join(",");
  await cdp("Tracing.start", params, sessionId);
  activeTrace = { sessionId };
}

/** Stop the active trace, write it to disk, and return its path. */
export async function stopTracing(options: any = {}) {
  if (!activeTrace) throw new Error("page.tracing.stop: no trace is active");
  const trace = activeTrace;
  const timeout = finiteNonNegativeNumber(
    options.timeout ?? 30000,
    "page.tracing.stop options.timeout",
  );
  activeTrace = null;
  const completion = tracingComplete(trace.sessionId, timeout);
  let event;
  try {
    await cdp("Tracing.end", {}, trace.sessionId);
    event = await completion.promise;
  } catch (error) {
    completion.cancel();
    throw error;
  }
  const handle = event?.params?.stream;
  if (!handle) throw new Error("page.tracing.stop: Chromium returned no trace stream");
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const chunk = await cdp("IO.read", { handle }, trace.sessionId);
      chunks.push(
        chunk.base64Encoded
          ? Buffer.from(chunk.data || "", "base64")
          : Buffer.from(chunk.data || "", "utf8"),
      );
      if (chunk.eof) break;
    }
  } finally {
    await cdp("IO.close", { handle }, trace.sessionId).catch(() => undefined);
  }
  const path =
    options.path ||
    join(tmpdir(), `ufo-browser-trace-${process.pid}-${++traceSequence}.json`);
  await mkdir(dirname(path), { recursive: true });
  await state.writeFile(path, Buffer.concat(chunks));
  return path;
}

function tracingComplete(sessionId: string, timeout: number) {
  let timer;
  let unsubscribe = () => undefined;
  let settle = () => undefined;
  const promise = new Promise<any>((resolve, reject) => {
    settle = resolve;
    unsubscribe = subscribeBrowserEvent(
      "Tracing.tracingComplete",
      sessionId,
      (event) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      },
    );
    if (timeout > 0) {
      timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`page.tracing.stop timed out after ${timeout}ms`));
      }, timeout);
    }
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
      unsubscribe();
      settle(null);
    },
  };
}

function finiteNonNegativeNumber(value, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return number;
}

function normalizeCategories(categories, screenshots) {
  const values = Array.isArray(categories)
    ? categories.map(String)
    : typeof categories === "string"
      ? categories.split(",").map((value) => value.trim()).filter(Boolean)
      : [
          "devtools.timeline",
          "v8.execute",
          "blink.user_timing",
          "loading",
          "disabled-by-default-devtools.timeline",
        ];
  if (screenshots) values.push("disabled-by-default-devtools.screenshot");
  return [...new Set(values)];
}
