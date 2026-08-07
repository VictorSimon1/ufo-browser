import { parentPort, workerData } from "node:worker_threads";
import { readChromeCookies } from "./cookies.js";
import { KeychainError, type KeychainErrorCode } from "./keychain.js";

type WorkerInput = {
  databasePath: string;
  nowSeconds?: number;
};

type KeychainResponse =
  | { type: "keychain-secret"; secret: Uint8Array }
  | { type: "keychain-error"; code: KeychainErrorCode };

if (!parentPort) throw new Error("Chrome Cookie worker requires a parent port");

const input = workerData as WorkerInput;
const keychain = {
  async readSecret(service: string) {
    parentPort!.postMessage({ type: "keychain-request", service });
    const response = await new Promise<KeychainResponse>((resolve) => {
      const listener = (message: KeychainResponse) => {
        if (
          message?.type !== "keychain-secret" &&
          message?.type !== "keychain-error"
        ) {
          return;
        }
        parentPort!.off("message", listener);
        resolve(message);
      };
      parentPort!.on("message", listener);
    });
    if (response.type === "keychain-error") {
      throw new KeychainError(response.code);
    }
    return Buffer.from(
      response.secret.buffer,
      response.secret.byteOffset,
      response.secret.byteLength,
    );
  },
};

try {
  const result = await readChromeCookies(
    input.databasePath,
    keychain,
    input.nowSeconds,
  );
  parentPort.postMessage({ type: "result", result });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    code: workerErrorCode(error),
  });
}

function workerErrorCode(error: unknown) {
  if (error instanceof KeychainError) return error.code;
  const message = error instanceof Error ? error.message : "";
  if (/database|sqlite|schema/i.test(message)) return "cookie-database-invalid";
  return "cookie-worker-failed";
}
