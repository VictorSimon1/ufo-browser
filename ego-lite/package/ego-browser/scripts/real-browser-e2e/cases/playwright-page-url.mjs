import { homeCase } from "./shared.mjs";

export const playwrightPageUrlCases = [
  {
    name: "regression PWB-03 page.url asynchronous contract",
    body: homeCase(`
      const initialUrl = await page.url();
      assertEqual(typeof initialUrl, "string", "PWB-03 awaited page.url returns a string");
      assertIncludes(initialUrl, baseUrl, "PWB-03 page.url reflects the current tab");

      const navigation = page.waitForURL(
        (url) => url.pathname === "/nav-target",
        { timeout: 5000 }
      );
      await page.getByRole("link", { name: "Go to nav target" }).click();
      assert(await navigation, "PWB-03 link navigation reaches nav target");
      assertIncludes(await page.url(), "/nav-target", "PWB-03 page.url reads the URL after navigation");
    `),
  },
];
