import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { ChromeStorageInspection } from "./storage-preflight.js";

type StoragePreflightWorkerMessage =
  | { type: "result"; result: ChromeStorageInspection }
  | { type: "error"; code: "storage-preflight-worker-failed" };

const STORAGE_PREFLIGHT_WORKER_TIMEOUT_MS = 15_000;

export function createChromeStoragePreflightWorker(
  workerPath: string,
  partitionsRoot: string,
) {
  return (
    _profileId: string,
    partitionId: string,
    copiedStorage: readonly string[],
  ) =>
    new Promise<ChromeStorageInspection>((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: {
          partitionPath: join(partitionsRoot, partitionId),
          copiedStorage: [...copiedStorage],
        },
      });
      let settled = false;
      const timeout = setTimeout(
        () => finish({ error: new Error("storage-preflight-worker-failed") }),
        STORAGE_PREFLIGHT_WORKER_TIMEOUT_MS,
      );
      const finish = (
        outcome: { result: ChromeStorageInspection } | { error: unknown },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void worker.terminate();
        if ("result" in outcome) resolve(outcome.result);
        else reject(outcome.error);
      };
      worker.on("message", (message: StoragePreflightWorkerMessage) => {
        if (message?.type === "result") {
          finish({ result: message.result });
        } else if (message?.type === "error") {
          finish({ error: new Error("storage-preflight-worker-failed") });
        }
      });
      worker.once("error", () =>
        finish({ error: new Error("storage-preflight-worker-failed") }),
      );
      worker.once("exit", () => {
        if (!settled) {
          finish({ error: new Error("storage-preflight-worker-failed") });
        }
      });
    });
}
