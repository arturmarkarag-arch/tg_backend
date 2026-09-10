# Allegro Stage 4 — direct order ingest

Date: 2026-09-11

## Scope

Stage 4 adds direct Allegro order ingestion while keeping Allegro completely independent from BaseLinker.

Each `AllegroAccount.accountId` owns:
- its own durable event cursor and bootstrap barrier;
- its own sync/error state and scheduler leadership;
- a local, non-PII order projection used by the admin UI.

No BaseLinker account ID or BaseLinker status is part of this ingest contract.

## Bootstrap

A first sync (or recovery after a long outage) performs these steps in order:

1. `GET /order/event-stats` and records the latest event as a barrier.
2. Reads current `READY_FOR_PROCESSING` checkout forms managed by `fulfillment.provider.id=SELLER` for active fulfillment statuses.
3. Writes the sanitized local projection.
4. Removes stale non-terminal local rows missing from the authoritative active snapshot.
5. Persists the barrier as the event cursor.
6. Later journal reads start after that cursor.

The barrier is captured before the snapshot so events that occur while the snapshot is being built are replayed afterward instead of being lost.

One Fulfillment orders (`fulfillment.provider.id=ALLEGRO`) never enter the warehouse projection.

## Event journal

The scheduler reads `GET /order/events` with a durable per-account `from` cursor. Events are transport notifications only; they are not treated as the final order state.

For operational events (`READY_FOR_PROCESSING`, `BUYER_CANCELLED`, `AUTO_CANCELLED`, `FULFILLMENT_STATUS_CHANGED`) the backend refreshes `GET /order/checkout-forms/{id}` and only advances the cursor after those exact refreshes succeed.

A 404 during exact refresh is treated as a stale checkout-form projection and removed. Allegro can replace checkout-form IDs when the buyer merges purchases.

Because Allegro order events are available for 60 days, an account whose last successful order poll is older than the configured recovery threshold is re-bootstrapped instead of trusting a potentially unrecoverable cursor.

## Local projection / privacy boundary

`AllegroOrderIndex` deliberately does not persist:
- buyer identity/contact data;
- delivery address;
- payment object/details;
- invoice data;
- raw Allegro checkout-form/event JSON.

It keeps only warehouse-operational data such as order/account identity, upstream statuses, marketplace, delivery method name/id, shipment summary, product/offer IDs, names, SKU, quantity, price and timestamps.

Normal list/search/pagination endpoints read Mongo only and perform zero Allegro API requests.

## Scheduler

Default cadence: `30s` per enabled + connected Allegro account.

Coordination is account-scoped through scheduler leadership and the order-sync lock. HTTP rate limiting remains owned by Stage 3 Allegro HTTP Core.

A transient journal error after successful bootstrap does not downgrade `bootstrapState=complete`; it increments sync failures and preserves the last successful cursor.

## Environment controls

Optional tuning:

```env
ALLEGRO_ORDER_POLL_MS=30000
ALLEGRO_ORDER_EVENT_LIMIT=200
ALLEGRO_ORDER_EVENT_PAGES_PER_TICK=2
ALLEGRO_ORDER_DETAIL_MAX_PER_TICK=100
ALLEGRO_ORDER_BOOTSTRAP_MAX_PAGES=100
ALLEGRO_ORDER_ERROR_BACKOFF_MS=60000
ALLEGRO_ORDER_REBOOTSTRAP_AFTER_DAYS=55
ALLEGRO_ORDER_SYNC_LOCK_TTL_MS=900000
```

Keep `ALLEGRO_ORDER_REBOOTSTRAP_AFTER_DAYS` below Allegro's 60-day event retention boundary.

## Admin HTTP API

- `GET /api/allegro/orders` — local list/search/pagination only.
- `GET /api/allegro/accounts/:accountId/orders/:orderId` — local detail only.
- `POST /api/allegro/sync` — explicit admin-triggered upstream synchronization.
- `GET /api/allegro/status` — account ingest state, cursor/last successful sync and scheduler diagnostics.

The browser has no polling loop that calls Allegro directly. Socket event `allegro_orders_changed` invalidates the local TanStack query cache after the server changes Mongo.

## Not in Stage 4

Stage 4 intentionally does not implement warehouse picking/problem/packed/sent commands, TTN creation, shipment labels or printing. Those operations need provider-neutral local workflow state and are planned for the following stages.
