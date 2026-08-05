export function keyboardRegressionCase() {
  return `
    await taskSpaces.useOrCreate(taskName);
    await resetHome();

    /* Issue 1: fill on type=email replaces the prior value without crashing.
       Before the fix, clearFirst's setSelectionRange threw InvalidStateError on
       type=email/number inputs and the whole fill rejected, writing nothing. */
    await page.evaluate("document.querySelector('#email-input').value = 'old@example.com'; window.__fixtureState.valueEvents['email-input'] = []; return true;");
    await page.locator("#email-input").fill("marcus.hale@example.com", { timeout: 3000 });
    const emailValue = await page.evaluate(() => document.querySelector('#email-input').value);
    assertEqual(emailValue, "marcus.hale@example.com", "fill replaces type=email value (Issue 1)");
    const emailEvents = await page.evaluate(() => (window.__fixtureState.valueEvents['email-input'] || []).join(','));
    assertIncludes(emailEvents, "input", "fill fires input on type=email (Issue 1)");
    assertIncludes(emailEvents, "change", "fill fires change on type=email (Issue 1)");

    /* Issue 1: same setSelectionRange crash on type=number. */
    await page.evaluate("document.querySelector('#number-input').value = '123'; return true;");
    await page.locator("#number-input").fill("456", { timeout: 3000 });
    const numberValue = await page.evaluate(() => document.querySelector('#number-input').value);
    assertEqual(numberValue, "456", "fill replaces type=number value (Issue 1)");

    /* Issue 2: non-bare selectors resolve through the unified element-resolver.
       Before the fix, the CSS path fed 'xpath=...' straight into querySelector
       and threw SyntaxError. */
    await page.locator('xpath=//input[@id="text-input"]').fill("via-xpath", { timeout: 3000 });
    const xpathValue = await page.evaluate(() => document.querySelector('#text-input').value);
    assertEqual(xpathValue, "via-xpath", "fill resolves xpath= selector (Issue 2)");

    /* Issue 2: dispatchEvent shares the same resolver path. */
    await page.evaluate("window.__fixtureState.keys = []; return true;");
    await page.locator('xpath=//input[@id="text-input"]').dispatchEvent("keydown", { key: "Enter" });
    const keys = await page.evaluate(() => window.__fixtureState.keys.join(','));
    assertIncludes(keys, "Enter", "dispatchEvent resolves xpath= selector (Issue 2)");

    /* Issue 2: setInputFiles shares the same resolver path (the pilot covered
       fill/dispatchEvent but left setInputFiles out). */
    await page.locator('xpath=//input[@id="file-input"]').setInputFiles(uploadPath);
    const xpathFile = await page.evaluate(() => Array.from(document.querySelector('#file-input').files).map((file) => file.name).join(','));
    assertEqual(xpathFile, "fixture-upload.txt", "setInputFiles resolves xpath= selector (Issue 2)");

    /* fill must persist on a react-style controlled input, whose native
       value-setter writeback fights synthetic value changes. */
    await page.locator("#controlled-input").fill("hello-react", { timeout: 3000 });
    const controlledValue = await page.evaluate(() => document.querySelector('#controlled-input').value);
    assertEqual(controlledValue, "hello-react", "fill persists value on a react-style controlled input");
    const controlledState = await page.evaluate(() => document.querySelector('#controlled-state').textContent);
    assert(controlledState.startsWith("hello-react"), "controlled state mirror reflects the filled value");
  `;
}
