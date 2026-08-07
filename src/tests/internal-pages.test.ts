import assert from "node:assert/strict";
import test from "node:test";
import {
  isDefaultNewTabUrl,
  isInternalNewTabUrl,
  logicalNavigationUrl,
  normalizeNavigationUrl,
  X_BROWSER_DEFAULT_NEW_TAB_URL,
} from "../main/internal-pages.js";

test("an empty navigation opens the real Google home page", () => {
  assert.equal(normalizeNavigationUrl(""), X_BROWSER_DEFAULT_NEW_TAB_URL);
  assert.equal(X_BROWSER_DEFAULT_NEW_TAB_URL, "https://www.google.com/");
  assert.equal(isDefaultNewTabUrl("https://www.google.com/"), true);
  assert.equal(isDefaultNewTabUrl("https://www.google.com.hk/?hl=zh-CN"), true);
  assert.equal(isDefaultNewTabUrl("https://www.google.co.uk/webhp"), true);
  assert.equal(isDefaultNewTabUrl("https://www.google.com/search?q=ufo"), false);
  assert.equal(isInternalNewTabUrl("x-browser://newtab/"), true);
  assert.equal(
    isInternalNewTabUrl("file:///Applications/UFO-Browser/dist/renderer/newtab.html"),
    true,
  );
});

test("legacy local new-tab URLs migrate to Google without masking navigation", () => {
  assert.equal(
    logicalNavigationUrl(
      "file:///Applications/UFO-Browser/dist/renderer/newtab.html",
      X_BROWSER_DEFAULT_NEW_TAB_URL,
    ),
    X_BROWSER_DEFAULT_NEW_TAB_URL,
  );
  assert.equal(
    logicalNavigationUrl("https://example.com/", X_BROWSER_DEFAULT_NEW_TAB_URL),
    "https://example.com/",
  );
  assert.equal(
    logicalNavigationUrl(
      "https://www.google.com.hk/?hl=zh-CN",
      X_BROWSER_DEFAULT_NEW_TAB_URL,
    ),
    X_BROWSER_DEFAULT_NEW_TAB_URL,
  );
});
