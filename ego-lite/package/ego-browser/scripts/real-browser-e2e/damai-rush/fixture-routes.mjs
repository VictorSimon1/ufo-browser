import { readFile } from "node:fs/promises";

import { runCompetition } from "./competition.mjs";
import { createTicketStore } from "./ticket-store.mjs";

const pageUrl = new URL("./index.html", import.meta.url);
const assetUrls = new Map([
  [
    "/e2e/damai-rush/app.js",
    {
      url: new URL("./app.js", import.meta.url),
      type: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/e2e/damai-rush/client-state.mjs",
    {
      url: new URL("./client-state.mjs", import.meta.url),
      type: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/e2e/damai-rush/styles.css",
    {
      url: new URL("./styles.css", import.meta.url),
      type: "text/css; charset=utf-8",
    },
  ],
]);

const apiBase = "/e2e/damai-rush/api";
const eventDetails = {
  eventId: "ego-starlight-tour-2026",
  title: "EGO STARLIGHT TOUR",
  city: "上海",
  venue: "西岸穹顶",
  performances: [
    {
      id: "shanghai-friday",
      date: "2026-10-09",
      weekday: "周五",
      time: "20:00",
    },
    {
      id: "shanghai-saturday",
      date: "2026-10-10",
      weekday: "周六",
      time: "19:30",
    },
    {
      id: "shanghai-sunday",
      date: "2026-10-11",
      weekday: "周日",
      time: "19:30",
    },
  ],
  priceTiers: [
    { id: "tier-480", price: 480, label: "看台" },
    { id: "tier-680", price: 680, label: "内场" },
    { id: "tier-980", price: 980, label: "前区" },
  ],
  attendees: [
    {
      id: "attendee-jack",
      name: "JACK W.",
      credential: "护照 · 71••••24",
      verified: true,
    },
    {
      id: "attendee-guest",
      name: "测试观演人",
      credential: "证件 · 31••••08",
      verified: true,
    },
  ],
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return JSON.parse(body || "{}");
}

export function createDamaiRushRoutes({
  capacity = 5,
  saleDelayMs = 3_000,
  queueDelayMs = 450,
} = {}) {
  let store = createTicketStore({
    capacity,
    saleAt: Date.now() + saleDelayMs,
  });
  let queueSequence = 0;

  function eventState() {
    const snapshot = store.snapshot();
    const status =
      Date.now() < snapshot.saleAt
        ? "scheduled"
        : snapshot.remaining > 0
          ? "on-sale"
          : "sold-out";
    return {
      ...eventDetails,
      status,
      serverNow: Date.now(),
      ...snapshot,
    };
  }

  return async function handleDamaiRushRoute(request, response, url) {
    if (request.method === "GET" && url.pathname === `${apiBase}/event`) {
      sendJson(response, 200, eventState());
      return true;
    }

    if (request.method === "POST" && url.pathname === `${apiBase}/reset`) {
      const body = await readJson(request);
      const nextCapacity = Math.min(
        50,
        Math.max(1, Number(body.capacity) || 5),
      );
      const nextDelay = Math.min(
        60_000,
        Math.max(0, Number(body.saleDelayMs) || 0),
      );
      store = createTicketStore({
        capacity: nextCapacity,
        saleAt: Date.now() + nextDelay,
      });
      queueSequence = 0;
      sendJson(response, 200, eventState());
      return true;
    }

    if (request.method === "POST" && url.pathname === `${apiBase}/orders`) {
      const body = await readJson(request);
      const requestId = String(body.requestId || "").trim();
      const buyer = String(body.buyer || "").trim();
      const performanceId = String(body.performanceId || "").trim();
      const priceTierId = String(body.priceTierId || "").trim();
      const attendeeId = String(body.attendeeId || "").trim();

      if (!requestId || !buyer) {
        sendJson(response, 400, { error: "buyer-and-request-id-required" });
        return true;
      }

      if (queueDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, queueDelayMs));
      }

      queueSequence += 1;
      const result = {
        queueNumber: queueSequence,
        ...store.reserve({
          requestId,
          buyer,
          performanceId,
          priceTierId,
          attendeeId,
        }),
      };
      const statusCode =
        result.status === "confirmed"
          ? 201
          : result.status === "too-early"
            ? 425
            : 409;
      sendJson(response, statusCode, result);
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === `${apiBase}/competition`
    ) {
      const body = await readJson(request);
      const nextCapacity = Math.min(
        20,
        Math.max(1, Number(body.capacity) || 5),
      );
      const userCount = Math.min(
        100,
        Math.max(1, Number(body.userCount) || 20),
      );
      store = createTicketStore({ capacity: nextCapacity, saleAt: 0 });
      queueSequence = 0;
      const competition = await runCompetition({ store, userCount });
      sendJson(response, 200, { ...competition, event: eventState() });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/e2e/damai-rush/") {
      const html = await readFile(pageUrl, "utf8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return true;
    }

    if (request.method === "GET" && assetUrls.has(url.pathname)) {
      const asset = assetUrls.get(url.pathname);
      const body = await readFile(asset.url, "utf8");
      response.writeHead(200, { "content-type": asset.type });
      response.end(body);
      return true;
    }

    return false;
  };
}
