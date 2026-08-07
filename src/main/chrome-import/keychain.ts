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
    if (!service || service.length > 200) {
      return Promise.reject(new Error("invalid Keychain service"));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, [service], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let length = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 64 * 1024) {
          child.kill();
          reject(new Error("Keychain secret exceeded the safe limit"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      child.once("error", () => reject(new KeychainError("keychain-unavailable")));
      child.once("exit", (code) => {
        if (code === 0) {
          const secret = Buffer.concat(chunks);
          if (!secret.length) reject(new KeychainError("keychain-item-missing"));
          else resolve(secret);
          return;
        }
        if (code === 2) reject(new KeychainError("keychain-canceled"));
        else if (code === 3) reject(new KeychainError("keychain-item-missing"));
        else reject(new KeychainError("keychain-failed"));
      });
    });
  }
}
