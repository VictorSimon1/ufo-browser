import test from "node:test";
import assert from "node:assert/strict";

import { installEgoSdk } from "../dist/src/index.js";

test("installEgoSdk keeps page.locator chainable while wrapping locator methods", () => {
  const originalLog = console.log;
  const target = { click() {} };
  try {
    installEgoSdk(target, { cliLog() {} });
    assert.equal(typeof target.click, "undefined");
    assert.equal(typeof target.page.locator, "function");
    assert.equal(typeof target.page.getByText("Allow").click, "function");
    assert.equal(typeof target.page.getByLabel("Email").fill, "function");
    assert.equal(
      typeof target.page.getByPlaceholder("Search").fill,
      "function",
    );
    assert.equal(typeof target.page.getByAltText("Logo").click, "function");
    assert.equal(typeof target.page.getByTitle("More").click, "function");
    const locator = target.page.locator("#target");
    assert.equal(locator && typeof locator, "object");
    assert.equal(typeof locator.click, "function");
    assert.equal(typeof locator.evaluateAll, "function");
    assert.equal(typeof locator.extractAll, "undefined");
    assert.equal(typeof locator.nth(1).click, "function");
    assert.equal(typeof locator.first().click, "function");
    assert.equal(typeof locator.last().click, "function");
    assert.equal(typeof locator.getByText("Save").click, "function");
    assert.equal(
      typeof locator.getByRole("button", { name: "Save" }).click,
      "function",
    );
    assert.equal(typeof locator.locator(".child").fill, "function");
    assert.equal(typeof locator.filter({ hasText: "Ready" }).click, "function");
    assert.equal(
      typeof target.page.getByText("Row").filter({ hasText: "Ready" }).nth(0)
        .click,
      "function",
    );
  } finally {
    console.log = originalLog;
  }
});

test("installEgoSdk preserves the asynchronous page.url contract", async () => {
  const originalLog = console.log;
  const target = {};
  try {
    installEgoSdk(target, {
      cliLog() {},
      context: {
        page: {
          url: async () => "https://example.com/current",
        },
      },
    });
    const value = target.page.url();
    assert.equal(typeof value.then, "function");
    assert.equal(await value, "https://example.com/current");
  } finally {
    console.log = originalLog;
  }
});

test("installEgoSdk exposes the site facade under ego.learnings", () => {
  const originalLog = console.log;
  const target = { ego: {} };
  try {
    installEgoSdk(target, { cliLog() {} });
    assert.equal(target.ego.learnings, target.ego.helpers.site);
    assert.equal(typeof target.ego.learnings.skills, "function");
    assert.equal(typeof target.ego.learnings.skillsForUrl, "function");
    assert.equal(typeof target.ego.learnings.runTool, "function");
    assert.equal(typeof target.ego.learnings.runBrowserTool, "function");
    assert.equal(typeof target.ego.learnings.learnContext, "function");
  } finally {
    console.log = originalLog;
  }
});
