import { homeCase } from "./shared.mjs";

export const playwrightPermissionCases = [
  {
    name: "regression PWB-10 permission capability",
    body: homeCase(`
      let outcome = "supported";
      try {
        await cdp("Browser.grantPermissions", {
          origin: baseUrl,
          permissions: ["clipboardReadWrite"],
        });
      } catch (error) {
        const message = error?.message || String(error);
        if (/wasn't found|method not found|not supported/i.test(message)) {
          outcome = "unsupported";
        } else {
          throw error;
        }
      }
      assertEqual(
        outcome,
        "unsupported",
        "PWB-10 unsupported permission capability is classified explicitly"
      );
      await page.locator("#text-input").fill("clipboard-free input");
      assertEqual(
        await page.locator("#text-input").inputValue(),
        "clipboard-free input",
        "PWB-10 text entry does not require raw permission CDP"
      );
    `),
  },
];
