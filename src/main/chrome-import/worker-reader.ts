import { Worker } from "node:worker_threads";
import type { ChromeCookieReadResult } from "./cookies.js";
import {
  KeychainError,
  type KeychainErrorCode,
  type KeychainProvider,
} from "./keychain.js";

type WorkerMessage =
  | { type: "keychain-request"; service: string }
  | { type: "result"; result: ChromeCookieReadResult }
  | { type: "error"; code: string };

const KEYCHAIN_ERROR_CODES = new Set<KeychainErrorCode>([
  "keychain-unavailable",
  "keychain-canceled",
  "keychain-item-missing",
  "keychain-failed",
]);

export function createChromeCookieWorkerReader(
  workerPath: string,
  keychain: KeychainProvider,
) {
  return (databasePath: string, nowSeconds?: number) =>
    new Promise<ChromeCookieReadResult>((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: { databasePath, nowSeconds },
      });
      let settled = false;
      const finish = (
        outcome: { result: ChromeCookieReadResult } | { error: unknown },
      ) => {
        if (settled) return;
        settled = true;
        void worker.terminate();
        if ("result" in outcome) resolve(outcome.result);
        else reject(outcome.error);
      };
      worker.on("message", (message: WorkerMessage) => {
        if (message?.type === "keychain-request") {
          void provideKeychainSecret(worker, keychain, message.service).catch(
            (error) => finish({ error }),
          );
          return;
        }
        if (message?.type === "result") {
          finish({ result: message.result });
          return;
        }
        if (message?.type === "error") {
          finish({ error: workerError(message.code) });
        }
      });
      worker.once("error", () =>
        finish({ error: new Error("cookie-worker-failed") }),
      );
      worker.once("exit", (code) => {
        if (!settled) {
          finish({ error: new Error("cookie-worker-failed") });
        }
      });
    });
}

async function provideKeychainSecret(
  worker: Worker,
  keychain: KeychainProvider,
  service: string,
) {
  let secret: Buffer | undefined;
  try {
    secret = await keychain.readSecret(service);
    const transferable = Uint8Array.from(secret);
    worker.postMessage(
      { type: "keychain-secret", secret: transferable },
      [transferable.buffer],
    );
  } catch (error) {
    const code =
      error instanceof KeychainError ? error.code : "keychain-failed";
    worker.postMessage({ type: "keychain-error", code });
  } finally {
    secret?.fill(0);
  }
}

function workerError(code: string) {
  if (KEYCHAIN_ERROR_CODES.has(code as KeychainErrorCode)) {
    return new KeychainError(code as KeychainErrorCode);
  }
  return new Error(
    code === "cookie-database-invalid"
      ? "cookie database invalid"
      : "cookie-worker-failed",
  );
}
