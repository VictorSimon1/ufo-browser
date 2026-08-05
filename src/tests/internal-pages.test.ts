import assert from "node:assert/strict";
import test from "node:test";
import {
  isInternalNewTabUrl,
  logicalNavigationUrl,
  normalizeNavigationUrl,
  X_BROWSER_DEFAULT_NEW_TAB_URL,
} from "../main/internal-pages.js";

test("an empty navigation opens the local new-tab page", () => {
  assert.equal(normalizeNavigationUrl(""), X_BROWSER_DEFAULT_NEW_TAB_URL);
  assert.equal(isInternalNewTabUrl("x-browser://newtab/"), true);
  assert.equal(
    isInternalNewTabUrl("file:///Applications/X-Browser/dist/renderer/newtab.html"),
    true,
  );
});

test("the persisted URL hides the physical new-tab file without masking navigation", () => {
  assert.equal(
    logicalNavigationUrl(
      "file:///Applications/X-Browser/dist/renderer/newtab.html",
      X_BROWSER_DEFAULT_NEW_TAB_URL,
    ),
    X_BROWSER_DEFAULT_NEW_TAB_URL,
  );
  assert.equal(
    logicalNavigationUrl("https://example.com/", X_BROWSER_DEFAULT_NEW_TAB_URL),
    "https://example.com/",
  );
});
