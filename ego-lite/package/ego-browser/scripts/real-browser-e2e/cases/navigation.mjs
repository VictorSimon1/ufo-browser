export function navigationCase() {
  return `
    await taskSpaces.useOrCreate(taskName);
    const home = await resetHome();

    const info = await page.info();
    assertEqual(info.title, "ego-lite helper e2e", "pageInfo reads fixture title");
    assertIncludes(info.url, baseUrl + "/", "pageInfo reads current URL");
    assert(info.w > 0 && info.h > 0, "pageInfo returns viewport size");
    assert(Number.isFinite(info.pw) && Number.isFinite(info.ph), "pageInfo returns page dimensions");

    const tabs = await browser.listTabs({ includeChrome: false });
    assert(tabs.some((tab) => tab.targetId === home.targetId), "listTabs includes home tab");
    const allTabs = await browser.listTabs();
    assert(allTabs.length >= tabs.length, "listTabs defaults to include chrome/internal tabs");

    const current = await browser.currentTab();
    assertEqual(current.targetId, home.targetId, "currentTab follows selected tab");

    const real = await browser.ensureRealTab();
    assert(real && real.targetId, "ensureRealTab returns a real tab");
    const realTabListed = (await browser.listTabs()).some((t) => t.targetId === real.targetId);
    assert(realTabListed, "ensureRealTab target appears in listTabs");

    const reused = await browser.openOrReuseTab(baseUrl + "/", { wait: true, timeout: 10000 });
    assertEqual(reused.reused, true, "openOrReuseTab reuses exact home URL");

    const byOrigin = await browser.openOrReuseTab(baseUrl + "/not-opened", {
      match: "origin",
      wait: false,
    });
    assertEqual(byOrigin.reused, true, "openOrReuseTab reuses by origin");

    const byPath = await browser.openOrReuseTab(baseUrl + "/?query=1", {
      match: "origin+path",
      wait: false,
    });
    assertEqual(byPath.reused, true, "openOrReuseTab reuses by origin and path");

    const unique = await browser.openOrReuseTab(baseUrl + "/secondary?unique=" + Date.now(), {
      wait: false,
    });
    assertEqual(unique.reused, false, "openOrReuseTab opens a unique exact URL");
    await browser.closeTab(unique.targetId);
    await browser.switchTab(home);

    const secondary = await browser.openOrReuseTab(baseUrl + "/secondary", {
      wait: true,
      timeout: 10000,
    });
    await browser.switchTab(secondary);
    assert(await page.waitForLoadState("load", { timeout: 10000 }), "secondary tab loads before target-id evaluation");
    const secondaryTitleViaTarget = await page.evaluate("return document.title", secondary.targetId);
    assertEqual(secondaryTitleViaTarget, "ego-lite secondary", "js evaluates against explicit target id");
    const homeTitleViaTarget = await page.evaluate("return document.title", home.targetId);
    assertEqual(homeTitleViaTarget, "ego-lite helper e2e", "js target id leaves current tab independent");

    const secondaryByIncludes = await browser.openOrReuseTab("/secondary", {
      match: "includes",
      wait: false,
    });
    assertEqual(secondaryByIncludes.reused, true, "openOrReuseTab reuses by URL substring");
    await browser.switchTab(secondary);
    const secondaryInfo = await page.info();
    assertEqual(secondaryInfo.title, "ego-lite secondary", "switchTab selects secondary tab");

    const closedId = await browser.closeTab(secondary);
    assertEqual(closedId, secondary.targetId, "closeTab returns closed target id");
    await browser.switchTab(home);

    const closeCurrent = await browser.openOrReuseTab(baseUrl + "/secondary?close=current", {
      wait: true,
      timeout: 10000,
    });
    await browser.switchTab(closeCurrent);
    const currentClosedId = await browser.closeTab();
    assertEqual(currentClosedId, closeCurrent.targetId, "closeTab closes current tab by default");
    await browser.switchTab(home);

    const afterCloseCurrent = await browser.currentTab();
    assertEqual(afterCloseCurrent.targetId, home.targetId, "switchTab restores home after closing current tab");

    await assertRejects(
      () => browser.closeTab(""),
      "closeTab requires a targetId",
      "closeTab validates empty target id"
    );

    await page.goto(baseUrl + "/nav-target", { waitUntil: "commit" });
    assert(await page.waitForLoadState("load", { timeout: 10000 }), "waitForLoadState observes goto navigation");
    const navInfo = await page.info();
    assertEqual(navInfo.title, "ego-lite nav target", "goto navigates current tab");

    const noWaitNav = await page.goto(baseUrl + "/nav-target?no-wait=1", {
      waitUntil: "commit",
    });
    assertEqual(noWaitNav.loaded, false, "goto supports waitUntil:commit");
    assert(await page.waitForLoadState("load", { timeout: 10000 }), "waitForLoadState can follow waitUntil:commit navigation");

    const nav = await page.goto(baseUrl + "/", { timeout: 10000, settle: 100 });
    assert(nav.loaded, "goto returns loaded true");

    const frame = await browser.iframeTarget("/frame.html");
    assert(frame === null || (typeof frame === "string" && frame.length > 0), "iframeTarget returns a non-empty session id or null");
    const missingFrame = await browser.iframeTarget("/missing-frame-for-e2e");
    assertEqual(missingFrame, null, "iframeTarget returns null for missing frames");
  `;
}
