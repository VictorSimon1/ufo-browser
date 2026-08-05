// @ts-nocheck
import { cdp, evaluate } from "../cdp-eval.js";
import { state } from "../state.js";

export type WaitForLoadOptions = {
  timeout?: number;
  until?: "load" | "domcontentloaded";
};

export async function waitForDocumentLoad(options: WaitForLoadOptions = {}) {
  const timeout = options.timeout ?? 15000;
  const ready =
    options.until === "domcontentloaded"
      ? ["interactive", "complete"]
      : ["complete"];
  const deadline = state.now() + timeout;
  while (state.now() < deadline) {
    let committed = true;
    try {
      const tree = await cdp("Page.getFrameTree");
      const url = tree.frameTree?.frame?.url || "";
      committed = url !== "" && url !== ":" && url !== "about:blank";
    } catch {
      // Page.getFrameTree may not be supported in some sessions; fall back to readyState only.
    }
    if (committed && ready.includes(await evaluate("document.readyState"))) {
      return true;
    }
    await state.sleep(300);
  }
  return false;
}
