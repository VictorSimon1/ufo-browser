import { homeCase } from "./shared.mjs";

export const playwrightLocatorCases = [
  {
    name: "regression PWB-05 locator zero auto-wait",
    body: homeCase(`
      await page.evaluate(() => {
        document.querySelector("#pwb05-delayed")?.remove();
        setTimeout(() => {
          const status = document.createElement("div");
          status.id = "pwb05-delayed";
          status.textContent = "PWB-05 delayed status";
          document.body.append(status);
        }, 500);
      });
      page.setDefaultTimeout(2500);
      const startedAt = Date.now();
      assertEqual(
        await page.locator("#pwb05-delayed").textContent(),
        "PWB-05 delayed status",
        "PWB-05 delayed locator read completes"
      );
      assert(Date.now() - startedAt >= 300, "PWB-05 locator waited for the missing element");
    `),
  },
  {
    name: "regression PWB-06 locator strictness",
    body: homeCase(`
      const locator = page.getByRole("button", { name: "Duplicate action" });
      await assertRejects(
        () => locator.click({ timeout: 1000 }),
        "matched 2 elements",
        "PWB-06 non-unique locator remains strict"
      );
      assertEqual(await locator.count(), 2, "PWB-06 count exposes both matches");

      const rawCss = page.locator(".duplicate-action");
      await assertRejects(
        () => rawCss.click({ timeout: 1000 }),
        "matched 2 elements",
        "PWB-06 raw CSS action remains strict"
      );

      const rawXpath = page.locator('xpath=//button[contains(@class, "duplicate-action")]');
      await assertRejects(
        () => rawXpath.innerText(),
        "matched 2 elements",
        "PWB-06 raw XPath read remains strict"
      );

      await rawCss.first().click({ timeout: 1000 });
      assert(await rawCss.first().isVisible(), "PWB-06 first resolves a confirmed legitimate duplicate");
      assertEqual(
        await rawXpath.nth(1).innerText(),
        "Duplicate action",
        "PWB-06 nth resolves a confirmed legitimate XPath duplicate"
      );
    `),
  },
];
