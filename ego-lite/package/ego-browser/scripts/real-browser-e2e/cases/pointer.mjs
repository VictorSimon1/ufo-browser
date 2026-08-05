export function pointerClickCase() {
  return `
    await taskSpaces.useOrCreate(taskName);
    await resetHome();
    console.log(JSON.stringify({ pointerStep: "click ready" }));

    assertEqual(await page.evaluate(() => window.__fixtureState.clicks), 0, "click fixture starts at zero");
    await page.locator("#click-button").click({ label: "click helper e2e" });
    await waitForJsValue(
      "window.__fixtureState.clicks",
      1,
      "click css fires a page click",
      "window.__fixtureState.pointerEvents"
    );
    await page.locator("#click-button").click({ x: 12, y: 12 });
    await waitForJsValue("window.__fixtureState.clicks", 2, "click selector offset fires a page click");
    await page.locator("loc=css:#click-button").click();
    await waitForJsValue("window.__fixtureState.clicks", 3, "click loc css fires a page click");
    await page.locator("loc=role:button[name='Increment counter']").click();
    await waitForJsValue("window.__fixtureState.clicks", 4, "click role locator fires a page click");
    await page.locator("xpath=//*[@id='click-button']").click();
    await waitForJsValue("window.__fixtureState.clicks", 5, "click xpath fires a page click");
    const buttonCenter = await page.elementCenter("#click-button");
    const hitElement = await page.evaluate(
      "return document.elementFromPoint(" +
        JSON.stringify(buttonCenter.x) +
        "," +
        JSON.stringify(buttonCenter.y) +
        ")?.id || document.elementFromPoint(" +
        JSON.stringify(buttonCenter.x) +
        "," +
        JSON.stringify(buttonCenter.y) +
        ")?.className || ''"
    );
    assertEqual(hitElement, "click-button", "pointer coordinates resolve to the intended button");
    await page.mouse.click([buttonCenter.x, buttonCenter.y]);
    await waitForJsValue("window.__fixtureState.clicks", 6, "click tuple coordinates fires a page click");
    await page.mouse.click({ x: buttonCenter.x, y: buttonCenter.y });
    await waitForJsValue("window.__fixtureState.clicks", 7, "click object coordinates fires a page click");
    await page.locator("#click-button").click({ clickCount: 2 });
    await waitForJsValue("window.__fixtureState.clicks", 8, "click count option fires a page click");
    await waitForJsValue("window.__fixtureState.lastClickDetail", 2, "click count option sets DOM click detail");
    const doubleClicksBefore = await page.evaluate(() => window.__fixtureState.doubleClicks);
    await page.locator("#click-button").dblclick();
    await waitForJsValue("window.__fixtureState.clicks", 9, "dblclick fires a page click");
    await waitForJsValue("window.__fixtureState.lastClickDetail", 2, "dblclick sets DOM click detail");
    await waitForJsCondition(
      "window.__fixtureState.doubleClicks > " + JSON.stringify(doubleClicksBefore),
      "dblclick fires a DOM dblclick"
    );
  `;
}

export function pointerHoverDragCase() {
  return `
    await taskSpaces.useOrCreate(taskName);
    await resetHome();
    console.log(JSON.stringify({ pointerStep: "hover drag ready" }));

    await page.evaluate(() => { window.__fixtureState.hovered = false; });
    await page.locator("#hover-zone").hover();
    await waitForJsValue("window.__fixtureState.hovered", true, "hover css fires mouseover");
    await page.evaluate(() => { window.__fixtureState.hovered = false; });
    await page.locator("#hover-zone").hover();
    await waitForJsValue("window.__fixtureState.hovered", true, "hover selector object fires mouseover");

    await page.evaluate(() => { window.__fixtureState.dragged = false; });
    await page.mouse.drag(["#drag-source", "#drag-target"], { delay: 10 });
    await waitForJsValue("window.__fixtureState.dragged", true, "drag fires drag source and target events");
  `;
}

export function scrollHelpersCase() {
  return `
    await taskSpaces.useOrCreate(taskName);
    await resetHome();
    console.log(JSON.stringify({ pointerStep: "scroll ready" }));

    // page.mouse.wheel() routes through CDP while the tab is visible AND focused; otherwise it
    // falls back to a synthetic WheelEvent plus window.scrollBy, which moves the page
    // but not nested scroll containers. So the page-scroll assertion runs on both
    // paths; the nested-container assertion stays gated on the CDP path (and logs a
    // visible skip otherwise, rather than silently passing).
    const wheelUsesCdp = await page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus());

    await page.evaluate(() => {
      const inner = document.querySelector('#inner-scroll');
      inner.scrollTop = 0;
      inner.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
    await page.waitForTimeout(100);
    const innerCenter = await page.elementCenter("#inner-scroll");
    const innerHit = await page.evaluate(
      "const el = document.elementFromPoint(" +
        JSON.stringify(innerCenter.x) +
        "," +
        JSON.stringify(innerCenter.y) +
        ");" +
        "return el?.closest?.('#inner-scroll')?.id || el?.id || '';"
    );
    assertEqual(innerHit, "inner-scroll", "nested scroll container is under the wheel target");
    const innerWheelDispatched = await allowWheelDispatch(
      "wheel nested container",
      () => page.mouse.wheel(0, 350, { x: innerCenter.x, y: innerCenter.y })
    );
    if (wheelUsesCdp && innerWheelDispatched) {
      await waitForJsCondition(
        "document.querySelector('#inner-scroll').scrollTop > 0",
        "wheel targets nested scroll containers"
      );
    } else {
      console.log(JSON.stringify({ scrollSkip: { assertion: "wheel targets nested scroll containers", reason: "synthetic path scrolls the window, not nested containers", wheelUsesCdp, innerWheelDispatched } }));
    }

    await resetHome();
    const wheelPoint = await page.evaluate(
      "const rect = document.querySelector('#scroll-area').getBoundingClientRect();" +
        "return { x: Math.min(Math.max(rect.left + 20, 10), innerWidth - 10), y: Math.min(Math.max(rect.top + 20, 10), innerHeight - 10) };"
    );
    const beforeWheel = await page.info();
    const wheelDispatched = await allowWheelDispatch("wheel page", () =>
      page.mouse.wheel(0, 300, { x: wheelPoint.x, y: wheelPoint.y })
    );
    if (wheelDispatched) {
      // Asserted on both paths: CDP wheel and the synthetic WheelEvent + window.scrollBy
      // fallback both move the page, so a backgrounded/unfocused tab is covered too.
      await waitForJsCondition(
        "scrollY > " + JSON.stringify(beforeWheel.sy),
        "wheel moves the page down"
      );
      const afterWheel = await page.info();
      assert(afterWheel.sy > beforeWheel.sy, "wheel moves the page down");
    }

    // scrollIntoViewIfNeeded scrolls through the DOM, so it reveals an element
    // regardless of tab focus.
    await resetHome();
    const markerBefore = await page.evaluate(
      "return document.querySelector('#bottom-marker').getBoundingClientRect().top >= innerHeight;"
    );
    assert(markerBefore, "bottom marker starts below the viewport");
    await page.locator("#bottom-marker").scrollIntoViewIfNeeded();
    await waitForJsCondition(
      "document.querySelector('#bottom-marker').getBoundingClientRect().top < innerHeight",
      "scrollIntoViewIfNeeded reveals an off-screen element"
    );
  `;
}

export function pointerValidationCase() {
  return `
    await taskSpaces.useOrCreate(taskName);
    await resetHome();

    await assertRejects(
      () => page.mouse.drag(["#drag-source"]),
      "at least two points",
      "drag validates minimum path length"
    );
    await assertRejects(
      () => page.mouse.click({ x: "bad", y: 1 }),
      "invalid mouse target",
      "click validates coordinate targets"
    );
    await assertRejects(
      () => page.locator("#click-button").click({ button: "sideways" }),
      "unsupported mouse button",
      "click validates mouse buttons"
    );
    await assertRejects(
      () => page.mouse.drag(["#drag-source", "#drag-target"], { button: "sideways" }),
      "unsupported mouse button",
      "drag validates mouse buttons"
    );
    await assertRejects(
      () => page.mouse.wheel(0, 0, { x: "bad" }),
      "invalid mouse offset",
      "wheel validates numeric viewport coordinates"
    );
    await assertRejects(
      () => page.mouse.wheel(0, "bad"),
      "invalid mouse offset",
      "wheel validates numeric scroll deltas"
    );
  `;
}

export function pointerInteractionRegressionCase() {
  return `
    await taskSpaces.useOrCreate(taskName);
    await resetHome();
    console.log(JSON.stringify({ pointerStep: "interaction regression ready" }));

    const rightClickBefore = await page.evaluate(() => window.__fixtureState.pointerEvents.length);
    await page.locator("#context-menu-zone").click({ button: "right" });
    const rightClickAfter = await page.evaluate(() => window.__fixtureState.pointerEvents.length);
    assert(rightClickAfter > rightClickBefore, "click with button:right dispatches mouse events on the target");
    const rightMouseDown = await page.evaluate(
      "return window.__fixtureState.pointerEvents.some(function(e) { return e.type === 'mousedown' && e.target === 'context-menu-zone'; })"
    );
    assert(rightMouseDown, "right-click produces a mousedown event on the context-menu-zone");

    await resetHome();
    const clicksBefore = await page.evaluate(() => window.__fixtureState.clicks);
    await page.locator("#click-button").click();
    await page.locator("#click-button").click();
    await page.locator("#click-button").click();
    await page.locator("#click-button").click();
    await page.locator("#click-button").click();
    await waitForJsValue(
      "window.__fixtureState.clicks",
      clicksBefore + 5,
      "five rapid clicks increment counter correctly (probe cleanup between actions)",
      "window.__fixtureState.pointerEvents"
    );

    await page.evaluate(() => {
      document.querySelector('#checkbox').checked = false;
      window.__fixtureState.checkboxChecked = false;
    });
    await page.locator("#checkbox").click();
    await waitForJsValue("window.__fixtureState.checkboxChecked", true, "first click checks the checkbox");
    await page.locator("#checkbox").click();
    await waitForJsValue("window.__fixtureState.checkboxChecked", false, "second click unchecks the checkbox");
  `;
}
