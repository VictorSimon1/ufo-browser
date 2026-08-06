import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    isInternalNewTabUrl("file:///Applications/UFO-Browser/dist/renderer/newtab.html"),
    true,
  );
});

test("the persisted URL hides the physical new-tab file without masking navigation", () => {
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
});

test("the bundled new-tab page is a local Google-style search surface", async () => {
  const html = await readFile(
    new URL("../renderer/newtab.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /aria-label="Google"/);
  assert.match(html, /action="https:\/\/www\.google\.com\/search"/);
  assert.match(html, /name="q"/);
  assert.match(html, /<title>新标签页<\/title>/);
  assert.doesNotMatch(html, /<script\b/i);
});
