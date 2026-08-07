import { Worker } from "node:worker_threads";
import type { ImportedChromeCookie } from "../chrome-import/cookies.js";
import type {
  CookieSyncCheckpoint,
  CookieSyncDiff,
} from "./cookie-diff.js";

type WorkerMessage =
  | { type: "result"; result: CookieSyncDiff }
  | { type: "error"; code: string };

export function createProfileCookieDiffWorker(workerPath: string) {
  return (
    source: ImportedChromeCookie[],
    target: ImportedChromeCookie[],
    checkpoint?: CookieSyncCheckpoint,
    now = Date.now(),
  ) =>
    new Promise<CookieSyncDiff>((resolve, reject) => {
      const worker = new Worker(workerPath);
      let settled = false;
      const finish = (result: CookieSyncDiff | Error) => {
        if (settled) return;
        settled = true;
        void worker.terminate();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      worker.once("message", (message: WorkerMessage) => {
        if (message?.type === "result") finish(message.result);
        else finish(new Error("cookie-diff-failed"));
      });
      worker.once("error", () => finish(new Error("cookie-diff-failed")));
      worker.once("exit", () => {
        if (!settled) finish(new Error("cookie-diff-failed"));
      });
      worker.postMessage({ source, target, checkpoint, now });
    });
}
