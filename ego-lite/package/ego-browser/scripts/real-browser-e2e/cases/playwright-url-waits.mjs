import { caseBody } from "./shared.mjs";

export const playwrightUrlWaitCases = [
  {
    name: "regression PWB-01 waitForURL predicate URL",
    body: caseBody(`
      await page.goto(baseUrl + "/nav-target", { waitUntil: "load" });
      let observed;
      assert(
        await page.waitForURL((url) => {
          observed = {
            isUrl: url instanceof URL,
            href: url.href,
            pathname: url.pathname,
          };
          return url.pathname === "/nav-target";
        }, { timeout: 3000 }),
        "PWB-01 waitForURL matches the current URL"
      );
      assert(observed?.isUrl, "PWB-01 predicate receives a URL object");
      assertEqual(observed.pathname, "/nav-target", "PWB-01 URL pathname is available");
    `),
  },
  {
    name: "regression PWB-02 waitForURL default load",
    body: caseBody(`
      const target = baseUrl + "/regression/slow-load?ms=1200&run=" + Date.now();
      await page.goto(target, { waitUntil: "commit", timeout: 5000 });
      const startedAt = Date.now();
      assert(
        await page.waitForURL(
          (url) => url.pathname === "/regression/slow-load",
          { timeout: 5000 }
        ),
        "PWB-02 waitForURL reaches its default load state"
      );
      const elapsedMs = Date.now() - startedAt;
      assertEqual(
        await page.evaluate(() => document.readyState),
        "complete",
        "PWB-02 default waitForURL returns after document load"
      );
      assert(elapsedMs >= 700, "PWB-02 waitForURL did not return at URL commit");
    `),
  },
];
