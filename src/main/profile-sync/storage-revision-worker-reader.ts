import { Worker } from "node:worker_threads";

export type StorageDatasetRevisions = Record<
  string,
  { sourceRevision: string | null; targetRevision: string | null }
>;

type WorkerMessage =
  | { type: "result"; result: StorageDatasetRevisions }
  | { type: "error"; code: string };

export function createStorageRevisionWorker(workerPath: string) {
  return (
    sourceRoot: string,
    targetRoot: string,
    datasets: string[],
  ) =>
    new Promise<StorageDatasetRevisions>((resolve, reject) => {
      const worker = new Worker(workerPath);
      let settled = false;
      const timeout = setTimeout(
        () => finish(new Error("storage-revision-timeout")),
        30_000,
      );
      timeout.unref?.();
      const finish = (result: StorageDatasetRevisions | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void worker.terminate();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      worker.once("message", (message: WorkerMessage) => {
        if (message?.type === "result") finish(message.result);
        else finish(new Error("storage-revision-failed"));
      });
      worker.once("error", () => finish(new Error("storage-revision-failed")));
      worker.once("exit", () => {
        if (!settled) finish(new Error("storage-revision-failed"));
      });
      worker.postMessage({ sourceRoot, targetRoot, datasets });
    });
}
