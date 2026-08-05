# Concert Ticket Rush Fixture

This fixture is part of the existing real-browser E2E environment. It reuses the server, random port, task space, lifecycle, assertion reporting, and cleanup owned by `scripts/real-browser-e2e/runner.mjs`.

It simulates performance, price-tier and attendee selection, a waiting room, queueing, electronic ticket confirmation, idempotent replay, and 20 virtual users competing for five tickets. It never contacts a real ticketing, payment, or identity service.

## Run

From `package/ego-browser`:

```bash
npm run e2e
```

To run only the ticket journey through the same runner:

```bash
EGO_BROWSER_REAL_E2E_ONLY="concert ticket rush" npm run e2e
```

The runner starts the shared fixture at a random local origin. During that run, the page is available at `/e2e/damai-rush/` on the printed fixture origin.

## Shared fixture routes

- `GET /e2e/damai-rush/` — concert ticket page.
- `GET /e2e/damai-rush/api/event` — event metadata, sale status, selections, and inventory.
- `POST /e2e/damai-rush/api/orders` — reserve one ticket with buyer, request ID, performance, price tier, and attendee.
- `POST /e2e/damai-rush/api/reset` — reset with `{ "capacity", "saleDelayMs" }`.
- `POST /e2e/damai-rush/api/competition` — run a bounded virtual-user competition with `{ "userCount", "capacity" }`.
