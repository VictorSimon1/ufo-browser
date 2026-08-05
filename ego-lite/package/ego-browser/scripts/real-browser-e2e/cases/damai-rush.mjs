import { caseBody } from "./shared.mjs";

export const damaiRushCase = caseBody(`
  await closeFixtureTabs();
  const tab = await browser.openOrReuseTab(baseUrl + "/e2e/damai-rush/", {
    wait: true,
    timeout: 10000,
  });
  await browser.switchTab(tab.targetId);
  await setStableViewport();

  assertEqual(
    await page.getByRole("heading", { name: "EGO STARLIGHT TOUR" }).innerText(),
    "EGO STARLIGHT TOUR",
    "ticket rush fixture is served by the shared E2E server",
  );
  await waitForJsValue(
    "document.documentElement.dataset.ready",
    "true",
    "ticket rush client is ready before interaction",
  );

  await page.locator('#reset-form input[name="capacity"]').fill("2");
  await page.locator('#reset-form input[name="saleDelay"]').fill("0");
  const resetResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/e2e/damai-rush/api/reset") &&
      response.status() === 200,
    { timeout: 10000 },
  );
  await page
    .getByRole("button", { name: "重置场景" })
    .evaluate((element) => element.click());
  assert(await resetResponse, "ticket rush reset uses the shared fixture server");
  await waitForJsValue(
    "document.querySelector('[data-testid=remaining]')?.textContent",
    "2",
    "ticket rush reset renders two available tickets",
  );

  await page.locator('input[value="shanghai-sunday"]').check();
  await page.locator('input[value="tier-980"]').check();
  await page.locator('input[value="attendee-guest"]').check();
  await page.getByLabel("下单账号").fill("Ego E2E Agent");
  const submitButton = page.getByRole("button", { name: "提交抢票" });
  assert(await submitButton.isEnabled(), "ticket request unlocks after reset");

  const orderResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/e2e/damai-rush/api/orders") &&
      response.status() === 201,
    { timeout: 10000 },
  );
  await submitButton.evaluate((element) => element.click());
  assert(await orderResponse, "ticket order is confirmed by the shared fixture server");
  await waitForJsCondition(
    'document.querySelector("#order-result")?.textContent.includes("EGO-0001")',
    "ticket rush renders the electronic ticket receipt",
  );
  assertEqual(
    await page.getByTestId("remaining").innerText(),
    "1",
    "confirmed order decrements inventory",
  );

  const replayResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/e2e/damai-rush/api/orders") &&
      response.status() === 201,
    { timeout: 10000 },
  );
  await page
    .getByRole("button", { name: "重放最后一次请求" })
    .evaluate((element) => element.click());
  assert(await replayResponse, "ticket request can be replayed through the shared fixture");
  await waitForJsCondition(
    'document.querySelector("#order-result")?.textContent.includes("同一请求安全重放")',
    "ticket rush renders the idempotent replay result",
  );
  assertEqual(
    await page.getByTestId("remaining").innerText(),
    "1",
    "idempotent replay does not consume another ticket",
  );

  const competitionResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/e2e/damai-rush/api/competition") &&
      response.status() === 200,
    { timeout: 10000 },
  );
  await page
    .locator("#competition-button")
    .evaluate((element) => element.click());
  assert(
    await competitionResponse,
    "virtual users compete through the shared fixture server",
  );
  await waitForJsValue(
    "document.querySelector('[data-testid=competition-confirmed]')?.textContent",
    "5",
    "five virtual users receive tickets",
  );
  assertEqual(
    await page.getByTestId("competition-total").innerText(),
    "20",
    "competition renders all twenty virtual users",
  );
  assertEqual(
    await page.getByTestId("competition-sold-out").innerText(),
    "15",
    "fifteen virtual users receive sold-out results",
  );
  assertEqual(
    await page.getByTestId("competition-remaining").innerText(),
    "0",
    "competition exhausts the five-ticket inventory",
  );
  assertEqual(
    await page.locator('[data-testid="competition-user"]').count(),
    20,
    "competition renders one result for every virtual user",
  );
`);
