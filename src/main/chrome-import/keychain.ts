import { spawn } from "node:child_process";

export const CHROME_SAFE_STORAGE_SERVICE = "Chrome Safe Storage";

export interface KeychainProvider {
  readSecret(service: string): Promise<Buffer>;
}

export type KeychainErrorCode =
  | "keychain-unavailable"
  | "keychain-canceled"
  | "keychain-item-missing"
  | "keychain-failed";

export class KeychainError extends Error {
  constructor(readonly code: KeychainErrorCode) {
    super(code);
    this.name = "KeychainError";
  }
}

export class MockKeychainProvider implements KeychainProvider {
  readonly requests: string[] = [];

  constructor(private readonly secret: Buffer | string) {}

  async readSecret(service: string) {
    this.requests.push(service);
    return Buffer.isBuffer(this.secret)
      ? Buffer.from(this.secret)
      : Buffer.from(this.secret, "utf8");
  }
}

export class MacKeychainProvider implements KeychainProvider {
  constructor(private readonly helperPath: string) {}

  readSecret(service: string): Promise<Buffer> {
    if (process.platform !== "darwin") {
      return Promise.reject(new KeychainError("keychain-unavailable"));
    }
    if (service !== CHROME_SAFE_STORAGE_SERVICE) {
      return Promise.reject(new Error("invalid Keychain service"));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, [], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let length = 0;
      let settled = false;
      const clearChunks = () => {
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0;
        length = 0;
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearChunks();
        reject(error);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) {
          chunk.fill(0);
          return;
        }
        length += chunk.length;
        chunks.push(chunk);
        if (length > 64 * 1024) {
          child.kill();
          fail(new KeychainError("keychain-failed"));
          return;
        }
      });
      child.once("error", () =>
        fail(new KeychainError("keychain-unavailable")),
      );
      child.once("exit", (code) => {
        if (settled) {
          clearChunks();
          return;
        }
        if (code === 0) {
          const secret = Buffer.concat(chunks, length);
          clearChunks();
          if (!secret.length) {
            fail(new KeychainError("keychain-item-missing"));
          } else {
            settled = true;
            resolve(secret);
          }
          return;
        }
        if (code === 2) fail(new KeychainError("keychain-canceled"));
        else if (code === 3) fail(new KeychainError("keychain-item-missing"));
        else fail(new KeychainError("keychain-failed"));
      });
    });
  }
}
