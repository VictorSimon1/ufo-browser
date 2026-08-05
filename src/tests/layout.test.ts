import test from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_CHROME_HEIGHT,
  calculateShellLayout,
} from "../main/shell-page-bounds.js";

test("pure browser mode fills the complete window width", () => {
  const layout = calculateShellLayout(1600, 1000);
  assert.deepEqual(layout.chat, { x: 0, y: 0, width: 0, height: 1000 });
  assert.deepEqual(layout.chrome, {
    x: 0,
    y: 0,
    width: 1600,
    height: BROWSER_CHROME_HEIGHT,
  });
  assert.deepEqual(layout.page, {
    x: 0,
    y: BROWSER_CHROME_HEIGHT,
    width: 1600,
    height: 1000 - BROWSER_CHROME_HEIGHT,
  });
});

test("layout never emits zero-sized page bounds", () => {
  const layout = calculateShellLayout(1, 1);
  assert.ok(layout.page.width >= 1);
  assert.ok(layout.page.height >= 1);
});

test("background compositor can preserve full browser outer geometry", () => {
  const page = { width: 1470, height: 751 };
  const layout = calculateShellLayout(
    page.width,
    page.height + BROWSER_CHROME_HEIGHT,
  );
  assert.deepEqual(layout.content, {
    x: 0,
    y: 0,
    width: 1470,
    height: 833,
  });
  assert.deepEqual(layout.page, {
    x: 0,
    y: BROWSER_CHROME_HEIGHT,
    width: 1470,
    height: 751,
  });
});
