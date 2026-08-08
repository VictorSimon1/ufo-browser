import test from "node:test";
import assert from "node:assert/strict";
import { displayNavigationAddress } from "../renderer/browser-address.js";

test("internal new-tab URLs never expose local app paths", () => {
  assert.equal(
    displayNavigationAddress(
      "file:///Users/example/x-browser/dist/renderer/newtab.html",
    ),
    "",
  );
  assert.equal(displayNavigationAddress("x-browser://newtab/"), "");
  assert.equal(displayNavigationAddress("about:blank"), "");
  assert.equal(displayNavigationAddress("https://www.google.com/"), "");
  assert.equal(displayNavigationAddress("https://google.com/webhp"), "");
});

test("normal and user file URLs stay visible", () => {
  assert.equal(
    displayNavigationAddress("https://example.com/path?q=1"),
    "https://example.com/path?q=1",
  );
  assert.equal(
    displayNavigationAddress("file:///Users/example/Documents/page.html"),
    "file:///Users/example/Documents/page.html",
  );
});
