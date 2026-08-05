import { homeCase } from "./shared.mjs";

export const playwrightTargetCases = [
  {
    name: "regression PWB-07 stale target guard",
    body: homeCase(`
      const scratch = await browser.openOrReuseTab(
        baseUrl + "/secondary?scratch=" + Date.now(),
        { wait: true, timeout: 5000 }
      );
      assert(scratch?.targetId, "PWB-07 new tab returns targetId");
      await browser.closeTab(scratch.targetId);
      const refreshed = await browser.listTabs();
      assert(
        !refreshed.some((tab) => tab.targetId === scratch.targetId),
        "PWB-07 closed target is absent from refreshed tabs"
      );
      await assertRejects(
        () => browser.switchTab(scratch.targetId),
        "switchTab target not found",
        "PWB-07 stale target fails at the validated boundary"
      );
    `),
  },
  {
    name: "regression PWB-08 target field guard",
    body: homeCase(`
      const tabs = await browser.listTabs();
      assert(
        tabs.every((tab) => typeof tab.targetId === "string" && tab.targetId.length > 0),
        "PWB-08 listTabs exposes targetId"
      );
      const missing = tabs.find((tab) => tab.url.includes("/never-created-target"));
      assertEqual(missing, undefined, "PWB-08 missing lookup is checked before dereference");
      await assertRejects(
        () => browser.switchTab({ id: tabs[0].targetId }),
        "switchTab requires a targetId",
        "PWB-08 id/targetId mismatch fails with an owned error"
      );
      const missingFrameTarget = await browser.iframeTarget("/never-created-frame");
      assertEqual(
        missingFrameTarget,
        null,
        "PWB-08 missing iframe target is an explicit nullable result"
      );
    `),
  },
];
