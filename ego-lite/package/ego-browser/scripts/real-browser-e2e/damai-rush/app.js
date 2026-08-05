import { deriveTicketView, formatCountdown } from "./client-state.mjs";

const apiBase = "/e2e/damai-rush/api";
const elements = {
  body: document.body,
  booking: document.querySelector("#booking"),
  buyer: document.querySelector("#buyer"),
  countdown: document.querySelector("#countdown"),
  competitionBoard: document.querySelector(".competition__board"),
  competitionButton: document.querySelector("#competition-button"),
  competitionConfirmed: document.querySelector(
    '[data-testid="competition-confirmed"]',
  ),
  competitionRemaining: document.querySelector(
    '[data-testid="competition-remaining"]',
  ),
  competitionResults: document.querySelector("#competition-results"),
  competitionSoldOut: document.querySelector(
    '[data-testid="competition-sold-out"]',
  ),
  competitionStatus: document.querySelector("#competition-status"),
  competitionTotal: document.querySelector('[data-testid="competition-total"]'),
  error: document.querySelector("#form-error"),
  inventory: document.querySelector('[data-testid="remaining"]'),
  orderResult: document.querySelector("#order-result"),
  replayButton: document.querySelector("#replay-button"),
  resetForm: document.querySelector("#reset-form"),
  rushButton: document.querySelector("#rush-button"),
  saleStatus: document.querySelector("#sale-status"),
  saleStatusWrap: document.querySelector(".sale-status"),
  steps: [...document.querySelectorAll("#queue-steps li")],
};

let currentEvent = null;
let lastRequest = null;
let submitting = false;

async function readJson(response) {
  const body = await response.json();
  if (!response.ok && !body.status) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function setJourney(activeStep, completedSteps = []) {
  for (const item of elements.steps) {
    const step = item.dataset.step;
    item.dataset.state = completedSteps.includes(step)
      ? "complete"
      : step === activeStep
        ? "active"
        : "";
  }
}

function renderEvent(event) {
  currentEvent = event;
  const view = deriveTicketView(event);
  elements.body.dataset.saleState = event.status;
  elements.inventory.textContent = String(event.remaining);
  elements.saleStatus.textContent = view.statusLabel;
  elements.saleStatusWrap.dataset.state = event.status;
  elements.rushButton.querySelector("span").textContent = submitting
    ? "队列处理中"
    : view.actionLabel;
  elements.rushButton.disabled = submitting || view.disabled;
  elements.countdown.textContent =
    event.status === "scheduled"
      ? formatCountdown(event.saleAt - Date.now())
      : "00:00.0";
}

async function refreshEvent() {
  const response = await fetch(`${apiBase}/event`, { cache: "no-store" });
  renderEvent(await readJson(response));
}

function selectedValue(name) {
  return new FormData(elements.booking).get(name)?.toString() || "";
}

function renderOrder(result, replayed) {
  if (result.status === "confirmed") {
    setJourney("ticket", ["waiting", "queue"]);
    elements.orderResult.className = "order-result order-result--success";
    elements.orderResult.textContent = replayed
      ? `同一请求安全重放 · 电子凭证 ${result.orderId}`
      : `抢票成功 · 电子凭证 ${result.orderId} · 队列序号 ${result.queueNumber}`;
    elements.replayButton.disabled = false;
    return;
  }

  if (result.status === "sold-out") {
    setJourney("queue", ["waiting"]);
    elements.orderResult.className = "order-result order-result--error";
    elements.orderResult.textContent =
      "未抢到：请求通过队列时，本轮库存已经售罄。";
    return;
  }

  setJourney("waiting");
  elements.orderResult.className = "order-result order-result--waiting";
  elements.orderResult.textContent = "开售尚未开始，请继续在候场室等待。";
}

async function placeOrder(requestId, replayed = false) {
  const buyer = elements.buyer.value.trim();
  const request = {
    requestId,
    buyer,
    performanceId: selectedValue("performanceId"),
    priceTierId: selectedValue("priceTierId"),
    attendeeId: selectedValue("attendeeId"),
  };

  if (
    !buyer ||
    !request.performanceId ||
    !request.priceTierId ||
    !request.attendeeId
  ) {
    elements.error.textContent =
      "请完整选择场次、票档、实名观演人，并填写下单账号。";
    return;
  }

  elements.error.textContent = "";
  submitting = true;
  renderEvent(currentEvent);
  setJourney("queue", ["waiting"]);
  elements.orderResult.className = "order-result order-result--waiting";
  elements.orderResult.textContent = replayed
    ? "正在重放同一请求…"
    : "已离开候场室，正在队列中竞争库存…";

  try {
    const response = await fetch(`${apiBase}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const result = await readJson(response);
    lastRequest = request;
    renderOrder(result, replayed);
  } catch (error) {
    elements.orderResult.className = "order-result order-result--error";
    elements.orderResult.textContent = `请求失败：${error.message}`;
  } finally {
    submitting = false;
    await refreshEvent();
  }
}

function createResultItem(result, rank) {
  const item = document.createElement("li");
  const success = result.status === "confirmed";
  item.dataset.status = result.status;
  item.dataset.testid = "competition-user";

  const position = document.createElement("span");
  position.className = "competition-result__rank";
  position.textContent = String(rank).padStart(2, "0");

  const identity = document.createElement("span");
  identity.className = "competition-result__identity";
  const name = document.createElement("strong");
  name.textContent = result.name;
  const arrival = document.createElement("small");
  arrival.textContent = `到达 +${String(result.delayMs).padStart(3, "0")}ms`;
  identity.append(name, arrival);

  const outcome = document.createElement("span");
  outcome.className = "competition-result__outcome";
  outcome.textContent = success
    ? `抢票成功 · ${result.orderId}`
    : "未抢到 · 库存已空";

  item.append(position, identity, outcome);
  return item;
}

function renderCompetition(competition) {
  const { summary } = competition;
  elements.competitionTotal.textContent = String(summary.total);
  elements.competitionConfirmed.textContent = String(summary.confirmed);
  elements.competitionSoldOut.textContent = String(summary.soldOut);
  elements.competitionRemaining.textContent = String(summary.remaining);
  elements.competitionStatus.textContent = `竞争结束：${summary.confirmed} 人成功，${summary.soldOut} 人因售罄失败，没有发生超卖。`;
  elements.competitionResults.replaceChildren();

  const sorted = [...competition.results].sort(
    (left, right) =>
      left.delayMs - right.delayMs ||
      left.virtualUserId.localeCompare(right.virtualUserId),
  );
  sorted.forEach((result, index) =>
    elements.competitionResults.append(createResultItem(result, index + 1)),
  );
  renderEvent(competition.event);
}

elements.booking.addEventListener("submit", (event) => {
  event.preventDefault();
  placeOrder(crypto.randomUUID());
});

elements.replayButton.addEventListener("click", () => {
  if (lastRequest) {
    placeOrder(lastRequest.requestId, true);
  }
});

elements.resetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.resetForm);
  const capacity = Number(data.get("capacity"));
  const saleDelayMs = Number(data.get("saleDelay")) * 1_000;
  const response = await fetch(`${apiBase}/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capacity, saleDelayMs }),
  });
  lastRequest = null;
  elements.replayButton.disabled = true;
  elements.orderResult.className = "order-result";
  elements.orderResult.textContent = `场景已重置：${capacity} 张票，${saleDelayMs / 1_000} 秒后开售。`;
  setJourney("waiting");
  renderEvent(await readJson(response));
});

elements.competitionButton.addEventListener("click", async () => {
  elements.competitionButton.disabled = true;
  elements.competitionButton.querySelector("span").textContent =
    "20 个请求正在排队…";
  elements.competitionBoard.setAttribute("aria-busy", "true");
  elements.competitionStatus.textContent =
    "并发窗口已打开，正在接收 20 个虚拟用户…";
  elements.competitionResults.replaceChildren();

  try {
    const response = await fetch(`${apiBase}/competition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userCount: 20, capacity: 5 }),
    });
    renderCompetition(await readJson(response));
  } catch (error) {
    elements.competitionStatus.textContent = `竞争测试失败：${error.message}`;
  } finally {
    elements.competitionButton.disabled = false;
    elements.competitionButton.querySelector("span").textContent =
      "20 人并发抢 5 张票";
    elements.competitionBoard.setAttribute("aria-busy", "false");
  }
});

setInterval(() => {
  if (currentEvent?.status === "scheduled") {
    renderEvent(currentEvent);
  }
}, 100);

setInterval(() => refreshEvent().catch(() => {}), 1_000);

refreshEvent()
  .then(() => {
    document.documentElement.dataset.ready = "true";
  })
  .catch((error) => {
    elements.orderResult.className = "order-result order-result--error";
    elements.orderResult.textContent = `无法读取测试场景：${error.message}`;
  });
