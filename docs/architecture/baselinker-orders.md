# BaseLinker fulfilment integration

## Boundary

BaseLinker is an external live order source. Its orders are **not** inserted into the existing `Order`, `OrderingSession`, `PickingTask` or delivery-group workflow. Those models belong to the seller -> group -> warehouse-session process and have different invariants.

The integration is split into two authorities:

- **BaseLinker** is authoritative for the order, customer, product snapshot, current catalog data, courier packages and labels.
- **Our MongoDB** is authoritative only for our own fulfilment progress: who is collecting an order, which lines were found, shortages/problems, packed/sent-local markers and audit history.

The BaseLinker token exists only in server env as `BASELINKER_API_TOKEN`. Upstream access remains read-only: only BaseLinker `get...` methods are used. Local POST/PATCH endpoints below mutate our MongoDB only; they never mutate BaseLinker.

## Access

Admins always have access. A non-admin receives the separate capability `User.permissions.baseLinkerPicking=true`, granted only from the admin Users screen.

This is intentionally a capability rather than a replacement primary role: a warehouse worker can keep the existing `warehouse` role and additionally collect BaseLinker orders. Removing/adding this capability does not grant generic admin access.

The server enforces the capability through `requireBaseLinkerPickingAccess`; hiding navigation in React is not authorization.

## Status filtering

BaseLinker status is an upstream property and may be used as an explicit list/display filter chosen by the operator. It is **not** a second hidden eligibility gate for our local fulfilment workflow.

There is no separate `eligibleStatusIds` configuration and no implicit intersection between BaseLinker status filters and local workflow filters. If an order is returned by the current `getOrders` query, the local workflow may display/claim it subject only to normal access, ownership and terminal-state rules. This prevents overlapping filters from silently hiding orders that were actually returned by BaseLinker.

Claim and pack still perform an exact read of the order before committing local workflow transitions. This read is for upstream existence/product-snapshot synchronization, not for a hidden status allow-list.

## Order reads

`getOrders` returns at most 100 orders. The adapter follows the documented `date_confirmed_from` cursor (`last date_confirmed + 1 second`) and enables custom extra fields, commissions, Connect data and discounts.

The upstream order object is kept intact. UI projections may format it, but do not strip new BaseLinker fields or become the source of truth.

A scan is bounded (`maxPages`, server maximum 90). If the bound is reached, `truncated=true` is returned and the UI must not claim that the result is complete.

## Product enrichment

The line snapshot from `getOrders.products[]` is the packing contract: ordered quantity, selected variant, SKU/EAN, attributes and IDs. It is never replaced by current catalog values.

Current catalog photos/details are enriched separately through inventory/external-storage read methods. Catalog enrichment is best effort and cached; failure to enrich one product must not hide the order line.

## Shipments / TTN / labels

Shipment reads are lazy so the order list does not generate N+1 traffic:

- `getOrderPackages(order_id)` runs only after **Відправлення та ТТН** is opened.
- `getPackageDetails(package_id)` runs only after package details are opened.
- `getLabel(courier_code, package_id)` runs only after **Накладна** is clicked.
- one order is modeled as `0..N` packages; `delivery_package_nr` in `getOrders` is only a snapshot/fallback hint.

No `createPackage`, status mutation, deletion or other BaseLinker write exists in this module.

## Local fulfilment state

Collection: `BaseLinkerPickingOrder`, unique by BaseLinker `order_id`.

Order states:

- no document -> `new`
- `in_progress`
- `problem` — at least one issue exists while some lines are still pending
- `ready_to_pack` — every line is fully picked
- `ready_to_pack_with_issue` — every line has been handled, but at least one line has a shortage/not-found/damaged/other issue
- `paused`
- `packed`
- `sent`

Item states:

- `pending`
- `picked`
- `shortage`
- `not_found`
- `damaged`
- `other`

Each line stores requested quantity, locally picked quantity, optional issue note and who/when made the last mark. The source snapshot has a fingerprint. The whole order has a fingerprint.

### Claim contract

A worker may own at most one active BaseLinker order at once. Claiming an order performs an exact `getOrders(order_id)` read first and synchronizes line composition before ownership is granted.

A claim has `lastActivityAt`; the client sends a local heartbeat every minute. The default stale timeout is ten minutes (`BASELINKER_PICKING_CLAIM_STALE_MS` can override it, minimum two minutes).

Another worker may take over only after the claim is stale. Admin may explicitly force takeover. There is no silent automatic takeover.

**Відкласти** releases ownership but keeps every item mark and issue. A later worker continues from the persisted state.

### Concurrent editing

Every operational document has a monotonically increasing `revision`. Item updates, release, pack, sent and reopen carry `expectedRevision`. A stale client is rejected instead of overwriting newer work.

Mutations are additionally protected by distributed `withLock` locks. Socket event `baselinker_picking_updated` patches other clients' local picking state without re-fetching the full BaseLinker order list.

### Upstream changes while collecting

Claim and pack are synchronization gates. Before packing, the server re-reads the exact BaseLinker order.

If BaseLinker changed its products:

- unchanged source lines preserve local progress;
- added lines become `pending`;
- changed lines become `pending`;
- removed lines disappear from active items;
- an audit event and change summary are saved;
- packing is blocked until the changed/new lines are checked again.

This prevents an operator from packing an obsolete local view.

### Problems, partial collection and packing

Saving a problem is a completed decision for that line, not the end of the whole order. The worker continues collecting every remaining `pending` line.

For a shortage the worker records the quantity physically found (`pickedQty`) plus an optional note. `not_found` records zero found. Damaged/other issues may also record the usable quantity that is physically being packed. Progress therefore distinguishes:

- handled lines (`state != pending`);
- fully picked lines;
- problem lines;
- requested quantity;
- physically picked quantity;
- missing quantity.

If the missing product is later found before packing, the worker can replace the issue with `picked`; the line then becomes fully complete. Resetting an item to `pending` is also allowed when it needs to be checked again.

When every line has been handled:

- no issues -> `ready_to_pack` and normal **Усе зібрано — запакував**;
- one or more issues -> `ready_to_pack_with_issue` and an explicit **Запакував те, що є / Запакував з проблемою** action.

The server never silently treats an issue as approval for partial packing. The partial/problem pack endpoint requires explicit `allowIssues=true`; otherwise it returns a confirmation-required conflict. Packing is also rejected while any line is still `pending`.

A packed order persists `packingMode` (`full`, `partial`, `with_issue`) and `packedSummary` (requested, physically packed, missing quantity and problem-line count). `order_packed_with_issues` history stores the exact issue lines, quantities and notes so the decision remains auditable.

### Send

`sent` means **our local physical handoff confirmation only**. With the current read-only BaseLinker key it does not change BaseLinker status or courier data. Courier TTN/label continues to be read from BaseLinker.

Admin may reopen `packed`/`sent` local state for correction; the action is audited.

## Operator UI

The BaseLinker page is a work queue, not merely an order viewer:

- workflow filters: `До роботи`, `Моє активне`, `Проблеми`, `Запаковані`, `Відправлені`, `Всі`;
- current worker's active order is kept visible even if it falls outside the selected date/status filter (exact order fallback read);
- each card shows local owner, status, picked lines/quantity and progress;
- a worker must **Взяти в роботу** before item controls become active;
- each product has **Є все — зібрав N шт.** and **Проблема**;
- problem types: not found, shortage, damaged, other; a problem stores the physical quantity already found and an optional note;
- a saved problem does not block work on the remaining lines;
- if the rest is later found, **Знайшов решту — зібрав N шт.** converts the issue to a fully picked line;
- **Відкласти** preserves work and releases the order;
- after every line is handled: normal full-pack action when complete, or an explicit partial/problem-pack action when issues remain;
- after physical carrier handoff: **Відправив**;
- TTN and label remain directly below the packing area;
- local fulfilment history is visible per order.
