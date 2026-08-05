/*
 * Workflow tests: multi-step scenarios that simulate real agent behavior
 * across pages, tabs, and state transitions. These cover paths that isolated
 * per-subsystem tests miss — state leakage, cross-tab consistency, and
 * sequential interaction chains.
 */

import { homeCase } from "./shared.mjs";

export const workflowCases = [
  {
    name: "workflow multi-page navigation",
    body: homeCase(`
      /* Step 1: capture initial home state. */
      const homeInfo = await page.info();
      assertEqual(homeInfo.title, "ego-lite helper e2e", "workflow: home title before navigation");

      /* Step 2: click the nav link to navigate within the current tab. */
      await page.locator("#nav-link").click();
      assert(await page.waitForLoadState("load", { timeout: 10000 }), "workflow: nav-target page loads");
      const navInfo = await page.info();
      assertEqual(navInfo.title, "ego-lite nav target", "workflow: page title changes after navigation");
      assertIncludes(navInfo.url, "/nav-target", "workflow: URL reflects nav-target");

      /* Step 3: open a secondary page in a new tab. */
      const secondary = await browser.openOrReuseTab(baseUrl + "/secondary", {
        wait: true,
        timeout: 10000,
      });
      assertEqual(secondary.reused, false, "workflow: secondary tab is new");
      await browser.switchTab(secondary);
      const secTitle = await page.evaluate(() => document.title);
      assertEqual(secTitle, "ego-lite secondary", "workflow: secondary tab title is correct");

      /* Step 4: switch back to the nav-target tab and verify its state persisted. */
      const tabs = await browser.listTabs({ includeChrome: false });
      const navTab = tabs.find((t) => String(t.url || "").includes("/nav-target"));
      assert(navTab, "workflow: nav-target tab still exists in tab list");
      await browser.switchTab(navTab.targetId);
      const navTitleAfterSwitch = await page.evaluate(() => document.title);
      assertEqual(navTitleAfterSwitch, "ego-lite nav target", "workflow: nav-target title persists across tab switches");

      /* Step 5: navigate back home via goto and verify clean state. */
      await page.goto(baseUrl + "/", { waitUntil: "commit" });
      assert(await page.waitForLoadState("load", { timeout: 10000 }), "workflow: home page reloads");
      const backHomeInfo = await page.info();
      assertEqual(backHomeInfo.title, "ego-lite helper e2e", "workflow: home title restored after multi-tab navigation");

      /* Step 6: close the secondary tab and verify tab count. */
      const tabsBeforeClose = (await browser.listTabs({ includeChrome: false })).length;
      await browser.closeTab(secondary.targetId);
      // Poll for tab count to decrease (closeTab may resolve before the tab list updates)
      const deadline = Date.now() + 2000;
      let remaining;
      do {
        remaining = await browser.listTabs({ includeChrome: false });
        if (remaining.length < tabsBeforeClose) break;
        await page.waitForTimeout(100);
      } while (Date.now() < deadline);
      assert(remaining.length < tabsBeforeClose, "workflow: tab count decreased after closing secondary");

      /* Step 7: verify browserFetch still works after all the navigation. */
      const text = await fetch.browser("/api/text", { timeout: 5 });
      assertEqual(text, "server text fixture", "workflow: browserFetch works after multi-page navigation");
    `),
  },
  {
    name: "workflow form interaction chain",
    body: homeCase(`
      /* Step 1: fill a text input and verify the value. */
      await page.locator("#text-input").fill("hello", { timeout: 3000 });
      assertEqual(
        await page.evaluate(() => document.querySelector('#text-input').value),
        "hello",
        "workflow: fill sets text value"
      );

      /* Step 2: append more text with insertText. */
      await page.locator("#text-input").click();
      await page.keyboard.insertText(" world");
      assertEqual(
        await page.evaluate(() => document.querySelector('#text-input').value),
        "hello world",
        "workflow: insertText appends to existing value"
      );

      /* Step 3: select-all then overwrite using fill (which clears first). */
      await page.locator("#text-input").fill("replaced", { timeout: 3000 });
      assertEqual(
        await page.evaluate(() => document.querySelector('#text-input').value),
        "replaced",
        "workflow: fill replaces entire value"
      );

      /* Step 4: fill the textarea and verify independently. */
      await page.locator("#text-area").fill("area content", { timeout: 3000 });
      assertEqual(
        await page.evaluate(() => document.querySelector('#text-area').value),
        "area content",
        "workflow: textarea value set independently"
      );
      /* Text input should not have been affected by textarea fill. */
      assertEqual(
        await page.evaluate(() => document.querySelector('#text-input').value),
        "replaced",
        "workflow: text input unchanged after textarea fill"
      );

      /* Step 5: toggle checkbox and verify state. */
      assertEqual(
        await page.evaluate(() => window.__fixtureState.checkboxChecked),
        false,
        "workflow: checkbox starts unchecked"
      );
      await page.locator("#checkbox").click();
      await waitForJsCondition("window.__fixtureState.checkboxChecked", "workflow: checkbox becomes checked after click");

      /* Step 6: click a second time to uncheck. */
      await page.locator("#checkbox").click();
      await waitForJsValue(
        "window.__fixtureState.checkboxChecked",
        false,
        "workflow: checkbox toggles back to unchecked"
      );

      /* Step 7: interact with dynamic DOM — add element, verify, remove, verify. */
      await page.locator("#add-element").click();
      const appeared = await page.waitForSelector("#dynamic-element", { timeout: 3000, state: "visible" });
      assertEqual(appeared, true, "workflow: dynamically added element becomes visible");
      const dynText = await page.evaluate(() => document.querySelector('#dynamic-element')?.textContent);
      assertIncludes(dynText, "Dynamic", "workflow: dynamic element has expected text");

      await page.locator("#remove-element").click();
      const gone = await page.waitForSelector("#dynamic-element", { timeout: 3000 });
      assertEqual(gone, false, "workflow: dynamically removed element disappears");

      /* Step 8: verify the click counter tracked only #click-button clicks (none in this workflow). */
      const totalClicks = await page.evaluate(() => window.__fixtureState.clicks);
      assertEqual(totalClicks, 0, "workflow: click counter only tracks #click-button, not form interactions");
    `),
  },
  {
    name: "workflow observation and recovery",
    body: homeCase(`
      /* Step 1: take a snapshot and capture refs for known elements. */
      const snap1 = await page.snapshotRaw({
        scope: "full_page",
        includeActionMarks: true,
        includeStableLocator: true,
      });
      const buttonRef = (snap1.refs || []).find(
        (r) => String(r?.role || "") === "button" && String(r?.name || "").includes("Increment")
      )?.backendNodeId;
      assert(buttonRef, "workflow: initial snapshot exposes button ref");

      /* Step 2: click using the ref and verify it works. */
      await page.locator("@" + buttonRef).click();
      await waitForJsValue("window.__fixtureState.clicks", 1, "workflow: click via ref increments counter");

      /* Step 3: modify the DOM, then verify the snapshot reflects the new element. */
      await page.locator("#add-element").click();
      await page.waitForSelector("#dynamic-element", { timeout: 3000, state: "visible" });
      const textAfterAdd = await page.snapshot({ scope: "full_page" });
      assertIncludes(String(textAfterAdd), "Dynamic!", "workflow: snapshot text includes dynamic element after mutation");

      /* Step 4: use the old button ref — it should still work because the
         element is still present (not replaced, just a sibling added). */
      await page.locator("@" + buttonRef).click();
      await waitForJsValue("window.__fixtureState.clicks", 2, "workflow: old ref still valid when element is unchanged");

      /* Step 5: remove the dynamic element and verify the ref becomes stale. */
      await page.locator("#remove-element").click();
      await page.waitForSelector("#dynamic-element", { timeout: 3000 });
      // The dynamic element is gone; trying to click its stale ref should
      // either fall back (if another element matches the role/name) or fail.
      // We just verify the element is truly removed.
      const dynExists = await page.evaluate(() => !!document.querySelector('#dynamic-element'));
      assertEqual(dynExists, false, "workflow: dynamic element removed from DOM");

      /* Step 6: take a screenshot and verify the file is created. */
      const screenshotPath = join(artifactDir, "workflow-shot.png");
      await page.screenshot({ path: screenshotPath });
      const screenshotStat = await stat(screenshotPath);
      assert(screenshotStat.size > 0, "workflow: screenshot file is non-empty");

      /* Step 7: drain events and verify the buffer mechanism. */
      const events = await page.drainEvents();
      assert(Array.isArray(events), "workflow: drainEvents returns an array");
      const emptyEvents = await page.drainEvents();
      assertEqual(emptyEvents.length, 0, "workflow: second drain returns empty buffer");

      /* Step 8: take a snapshot and verify it reflects current DOM state. */
      const text = await page.snapshot({ scope: "full_page" });
      assertIncludes(text, "Helper e2e fixture", "workflow: snapshot includes page heading");
      // Dynamic element was removed, so its text should not appear
      const hasDynamic = String(text).includes("Dynamic!");
      assertEqual(hasDynamic, false, "workflow: snapshot reflects removal of dynamic element");
    `),
  },
  {
    name: "workflow locator waits without fixed sleeps",
    body: homeCase(`
      await page.getByLabel("Text input").fill("status ready", { timeout: 3000 });
      assertEqual(await page.getByLabel("Text input").inputValue(), "status ready", "workflow: label locator fills input without fixed sleeps");

      await page.getByText("Add element", { exact: true }).click();
      assert(
        await page.locator("#dynamic-element").waitFor({ timeout: 3000, state: "visible" }),
        "workflow: locator.waitFor observes dynamic element"
      );
      assertIncludes(
        await page.locator("#dynamic-element").textContent(),
        "Dynamic!",
        "workflow: dynamic text is readable after locator.waitFor"
      );

      await page.getByText("Remove element", { exact: true }).click();
      assertEqual(
        await page.locator("#dynamic-element").waitFor({ timeout: 3000 }),
        false,
        "workflow: locator.waitFor observes element removal"
      );
    `),
  },
];
