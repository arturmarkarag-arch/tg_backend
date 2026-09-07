# BaseLinker multi-account fulfilment contract

Status: **Greenfield, account-scoped contract with no legacy BaseLinker support**. The production design has no legacy credentials, fallback identities, single-account fallback routes, or raw-order mirrors.

## 1. Authorities and domain boundary

BaseLinker is the external source of truth for upstream orders, order statuses, order sources, catalog/inventory metadata, courier packages and labels.

MongoDB is authoritative only for our application state:

- BaseLinker account identity/configuration;
- local picking ownership, progress and problem-resolution state;
- local packing/sent audit;
- a minimal account-scoped Intake index used for server-side paging/search;
- a non-PII product-image cache for worker cards;
- print jobs and application-owned history.

BaseLinker orders are not copied into the seller/group/session `Order`, `OrderingSession`, `PickingTask` or delivery-group domains.

The only intentional BaseLinker order-status write in this fulfilment flow is the operator **Відправив** action. It writes the configured Sent status for the same BaseLinker account and exact-rereads the order before local Sent is persisted.

## 2. Identity and account isolation

The durable identity of an upstream order is the composite:

`baseLinkerAccountId + orderId`

An `order_id` alone is never globally unique in our application. All queue, picking, print and API-usage state is scoped by the configured BaseLinker account UUID. Two connected accounts may legitimately contain the same BaseLinker `order_id` without colliding.

## 3. Read-path contract: zero BaseLinker I/O

Normal worker/admin list operations must not call BaseLinker:

- opening the BaseLinker orders page;
- pagination;
- changing page size;
- search/filtering;
- rendering product images from the cached worker projection.

`GET /baselinker/orders` reads the local account-scoped Intake index and the non-PII image cache only. The frontend must not speculatively prefetch adjacent pages.

The index stores only the minimum worker projection required by the UI: technical order/source/status/timestamp identifiers and sanitized product-line fields such as name, SKU, EAN, quantity and exact product/storage identity. It must not store customer names, addresses, phone numbers, e-mail, payment/invoice details or a raw BaseLinker order payload.

## 4. Synchronization strategy

The queue is defined by the configured **Intake BaseLinker status**, not by a business date window.

Synchronization has two layers:

1. **Full confirmed Intake reconcile** — periodically scans the configured Intake status and repairs the complete local membership/index. This is the correctness safety-net and bootstrap path. The `getOrders` scan uses `status_id` plus the ascending `id_from` cursor to paginate through every confirmed order in that status. `id_from` is only transport-level pagination for bootstrap/full reconcile; it is not a date, period, or business-membership filter. Authoritative queue membership remains the configured Intake status.
2. **Journal delta** — between full reconciles, `getJournalList` detects recently changed orders. Only the affected order IDs are exact-read and refreshed/removed from the local index.

The journal is an accelerator, never the sole source of correctness. Its cursor tracks upstream change-log progress independently of the `id_from` order-pagination cursor. If the journal is disabled, unavailable, empty, or its cursor cannot be established, the system remains correct through the next full reconcile and does not hammer `getJournalList` every scheduler tick.

Warehouse fulfilment reads use confirmed orders only (`get_unconfirmed_orders=false`). Unconfirmed BaseLinker orders are not eligible for the picking/packing flow because their data may still be incomplete.

## 5. Exact verification before critical mutations

The zero-upstream read path does not weaken mutation safety. Critical operations exact-read the current BaseLinker order immediately before acting, including picking/claim validation and status-changing fulfilment actions.

If the order is no longer in the expected upstream status/account scope, the mutation fails closed and local state is reconciled instead of trusting stale list data.

## 6. Product-image cache

Worker cards may use a persistent non-PII product-image cache keyed by:

`baseLinkerAccountId + exact BaseLinker product identity`

Only resolution state, first image URL and refresh timestamps are persisted. Catalog warming runs in the background with a strict per-cycle request cap so media enrichment cannot consume the whole BaseLinker API allowance.

Transient transport/API lookup failures are not cached as a successful 24-hour result.

## 7. API budget and observability

Every real outgoing BaseLinker HTTP call passes through the central client and is recorded in a **rolling 60-second window** by:

- BaseLinker account;
- API method;
- usage stage (for example `queue_journal`, `queue_full_scan`, `picking_exact_verify`, `product_catalog_sync`).

The limiter is account-scoped and Redis-backed/atomic when Redis is available, with a local fallback for single-process operation. The application budget is intentionally kept below BaseLinker's published account API ceiling to leave safety headroom.

`GET /baselinker/api-usage` is admin-only and reads our own meter. Polling this endpoint does not make a BaseLinker API request. The BaseLinker admin page refreshes that meter independently through TanStack Query.

## 8. Shift board / Telegram history

The frequently polled shift board contains only the operational summary required by the screen (shop/seller/review state/time). It must not embed the Telegram delivery ledger on every poll.

Telegram delivery history is an admin-only lazy read for a specific seller and is requested only after that seller's history panel is opened.

## 9. Cleanup contract

The BaseLinker cleanup command removes all application-owned BaseLinker state, including:

- account-scoped Intake index rows;
- picking state;
- print jobs/agents;
- non-PII product-image cache;
- current scheduler/index state keys;
- explicitly retired legacy BaseLinker cache/journal collections/settings.

Cleanup remains dry-run by default and retains its TEST/PROD environment guards and destructive confirmations.

## 10. Release invariants

A release must preserve all of the following:

- no list/search/pagination BaseLinker I/O;
- no speculative adjacent-page BaseLinker prefetch;
- confirmed-only fulfilment reads;
- journal + periodic full-reconcile safety-net;
- exact upstream verification before critical mutations;
- bounded catalog warming;
- account-scoped rolling-60s limiter/meter;
- lazy Telegram history on Shift Board;
- composite account/order identity everywhere.

Official API references used for the upstream contract:

- https://api.baselinker.com/
- https://api.baselinker.com/?method=getOrders
- https://api.baselinker.com/?method=getJournalList
