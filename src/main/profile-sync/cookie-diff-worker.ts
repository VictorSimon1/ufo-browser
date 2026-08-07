import { parentPort } from "node:worker_threads";
import type { ImportedChromeCookie } from "../chrome-import/cookies.js";
import {
  diffProfileCookies,
  type CookieSyncCheckpoint,
} from "./cookie-diff.js";

type CookieDiffRequest = {
  source: ImportedChromeCookie[];
  target: ImportedChromeCookie[];
  checkpoint?: CookieSyncCheckpoint;
  now?: number;
};

if (!parentPort) throw new Error("Profile Cookie diff worker requires a parent port");

parentPort.once("message", (request: CookieDiffRequest) => {
  try {
    parentPort!.postMessage({
      type: "result",
      result: diffProfileCookies(
        request.source,
        request.target,
        request.checkpoint,
        request.now,
      ),
    });
  } catch {
    parentPort!.postMessage({ type: "error", code: "cookie-diff-failed" });
  }
});
