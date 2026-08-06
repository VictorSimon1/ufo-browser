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
    height: 1000,
  });
  assert.deepEqual(layout.overlay, {
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

test("page surface preserves a full-window viewport below browser chrome", () => {
  const page = { width: 1470, height: 831 };
  const layout = calculateShellLayout(page.width, page.height);
  assert.deepEqual(layout.content, {
    x: 0,
    y: 0,
    width: 1470,
    height: 831,
  });
  assert.deepEqual(layout.page, {
    x: 0,
    y: BROWSER_CHROME_HEIGHT,
    width: 1470,
    height: 831,
  });
  assert.deepEqual(layout.overlay, {
    x: 0,
    y: BROWSER_CHROME_HEIGHT,
    width: 1470,
    height: 831 - BROWSER_CHROME_HEIGHT,
  });
});
