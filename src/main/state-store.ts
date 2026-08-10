import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserState } from "./types.js";

export const EMPTY_BROWSER_STATE: BrowserState = {
  version: 1,
  nextSpaceId: 1,
  spaces: [],
};

export class BrowserStateStore {
  private writeQueue = Promise.resolve();

  constructor(readonly path: string) {}

  async load(): Promise<BrowserState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.spaces)) {
        throw new Error("unsupported browser state");
      }
      return parsed;
    } catch (error: any) {
      if (error?.code === "ENOENT") return structuredClone(EMPTY_BROWSER_STATE);
      throw error;
    }
  }

  save(state: BrowserState): Promise<void> {
    const snapshot = structuredClone(state);
    this.writeQueue = this.writeQueue.then(() => this.writeAtomically(snapshot));
    return this.writeQueue;
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  private async writeAtomically(state: BrowserState) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temp, 0o600);
    await rename(temp, this.path);
  }
}
