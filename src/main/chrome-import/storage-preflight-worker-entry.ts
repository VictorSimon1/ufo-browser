import { parentPort, workerData } from "node:worker_threads";
import { inspectAndPruneChromeStorageSnapshot } from "./storage-preflight.js";

type StoragePreflightWorkerInput = {
  partitionPath: string;
  copiedStorage: string[];
};

if (!parentPort) {
  throw new Error("Chrome storage preflight worker requires a parent port");
}

try {
  const input = workerData as StoragePreflightWorkerInput;
  if (
    typeof input?.partitionPath !== "string" ||
    !Array.isArray(input?.copiedStorage)
  ) {
    throw new Error("invalid Chrome storage preflight worker input");
  }
  const result = await inspectAndPruneChromeStorageSnapshot(
    input.partitionPath,
    input.copiedStorage,
  );
  parentPort.postMessage({ type: "result", result });
} catch {
  parentPort.postMessage({
    type: "error",
    code: "storage-preflight-worker-failed",
  });
}
