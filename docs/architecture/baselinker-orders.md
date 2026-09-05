# BaseLinker fulfilment integration

## Boundary

BaseLinker is an external live order source. Its orders are **not** inserted into the existing `Order`, `OrderingSession`, `PickingTask` or delivery-group workflow. Those models belong to the seller -> group -> warehouse-session process and have different invariants.

The integration is split into two authorities:

- **BaseLinker** is authoritative for the order, customer, product snapshot, current catalog data, courier packages and labels.
- **Our MongoDB** is authoritative only for our own fulfilment progress: who is collecting an order, which lines were found, shortages/problems, packed/sent-local markers and audit history.

The BaseLinker token exists only in server env as `BASELINKER_API_TOKEN`. Upstream access remains read-only: only BaseLinker `get...` methods are used. Local POST/PATCH endpoints below mutate our MongoDB only; they never mutate BaseLinker.

## Account isolation

Every persisted BaseLinker cache row, picking record, print job, queue setting,
journal cursor and scheduler/worker lock belongs to an `accountScope`. Queries
are tenant-scoped at the Mongoose model boundary, not only in individual
services. A missing filter in future service code therefore fails closed and
cannot expose another BaseLinker account's data.

BaseLinker does not publish a documented account-identity endpoint. Configure
`BASELINKER_ACCOUNT_KEY` with a stable, non-secret shop identifier for an
explicit binding. Keep that value unchanged when regenerating the API token for
the same BaseLinker account, and change it when intentionally switching to a
different account.

Without the explicit key, the server derives an opaque hashed scope from the
owner component of BaseLinker's standard numeric token format. This preserves
the account namespace across normal token regeneration. If an unknown token
format is encountered, the full token is fingerprinted instead: rotation then
starts a new isolated namespace rather than risking a cross-account merge.
Neither the token nor its numeric components are persisted as the scope.

Legacy documents that have no `accountScope` are retained in MongoDB but are
invisible to all live account-scoped reads. They must never be assigned to a
shop automatically because historical mixed rows cannot be attributed safely.
Queue settings are also per-account, so a newly selected account must have its
three statuses selected once before its cache warms.

## Access

Admins always have access. Warehouse operators use the dedicated primary role `baselinker`, assigned only from the admin Users screen. That role is isolated to the BaseLinker module and does not inherit seller/warehouse application access.

This is intentionally a capability rather than a replacement primary role: a warehouse worker can keep the existing `warehouse` role and additionally collect BaseLinker orders. Removing/adding this capability does not grant generic admin access.

The server enforces the capability through `requireBaseLinkerPickingAccess`; hiding navigation in React is not authorization.

## Status filtering and background synchronization

Administrators select three distinct BaseLinker statuses in **Settings → System → BaseLinker work queue**:

- **Intake / ready to pack** — the only upstream status scanned without a date limit. Every order currently in this explicitly selected status is eligible, including `confirmed=false` rows whose `date_confirmed` is still empty.
- **Sent / Wysłano** — a read-only history shelf limited to the last 30 days. BaseLinker `getOrders` is called with this `status_id` plus a 30-day `date_confirmed_from` boundary so old sent history is not downloaded forever.
- **Cancelled / Anulowane** — never mass-scanned historically. It is used as a terminal signal when journal/exact refresh shows that an order already known to our queue moved to the selected cancelled status.

The old single `statusId` setting is treated only as a migration fallback for Intake. The queue is not considered configured until Sent and Cancelled are also selected, and all three IDs must be different. The API token remains server-side.

Admin-only routes: `GET/POST /admin/baselinker-settings` and `GET /admin/baselinker-settings/statuses`. Status options come from `getOrderStatusList`; saves are validated against the current BaseLinker list and persisted in an account-scoped `AppSetting` namespace based on `baselinker.queueSettings.v1`. Every save changes a revision/scope key so an older scan cannot publish into a newer configuration or account.

The scheduled full reconciliation scans only two upstream subsets:

1. all Intake orders, including unconfirmed rows, paged with BaseLinker's `id_from` cursor and no date boundary;
2. confirmed Sent orders with the fixed 30-day `date_confirmed_from` boundary.

Cancelled is intentionally not a third historical scan. Journal events refresh exact `order_id`s. Before an exact refresh is published, the server remembers whether that order was already present in our cache. If such a known order is now Cancelled, it is materialised as an **Updated** attention record even when nobody had claimed it yet. The card is read-only until an operator acknowledges it with **Прийнято**.

`GET /orders` reads MongoDB only and never starts an upstream scan. It returns `baselinker_queue_not_configured` until all three statuses are selected and `baselinker_queue_warming` until a complete scoped snapshot exists. A truncated BaseLinker scan is rejected before sweep/publication.

The journal is the incremental path. For every BaseLinker event that can change something visible or operational on an order (products, payment, order data/status, delivery, package/label state, invoice, receipt, merge/split/copy), the server fetches only the affected `order_id` through exact `getOrders(order_id)`, reconciles the current snapshot, and marks already locally tracked work as **Updated**. Blacklist-only events are ignored. This avoids rescanning the whole queue after every journal tick.

BaseLinker remains source of truth. The integration uses only read methods; no warehouse action changes a BaseLinker order/status. Local progress and acknowledgement live only in `BaseLinkerPickingOrder`.

`/status` exposes the three configured status IDs/names, fixed `sentLookbackDays=30`, cache/journal readiness, timestamps and last sync error. Errors persist across ticks/restarts with bounded retry backoff.

Upstream reference: [getOrders](https://api.baselinker.com/index.php?method=getOrders), [getJournalList](https://api.baselinker.com/index.php?method=getJournalList).

## Product enrichment

The line snapshot from `getOrders.products[]` is the packing contract: ordered quantity, selected variant, SKU/EAN, attributes and IDs. It is never replaced by current catalog values.

Current catalog photos/details are enriched separately through inventory/external-storage read methods. Catalog enrichment is best effort and cached; failure to enrich one product must not hide the order line.

## Shipments / TTN / labels

Shipment reads are lazy so the order list does not generate N+1 traffic:

- `getOrderPackages(order_id)` runs only after **Відправлення та ТТН** is opened.
- `getPackageDetails(package_id)` runs only after package details are opened.
- `getOrders.delivery_package_nr` is the lightweight hint used to show the **ТТН** action only when a shipment exists.
- `getLabel(courier_code, package_id)` runs only after **ТТН** is clicked.
- one order is modeled as `0..N` packages; `delivery_package_nr` in `getOrders` is only a snapshot/fallback hint.

No `createPackage`, status mutation, deletion or other BaseLinker write exists in this module.

## Local fulfilment state

Collection: `BaseLinkerPickingOrder`, unique by `(accountScope, BaseLinker order_id)`.

Detailed picking states:

- no document -> `new`
- `in_progress`
- `problem` — at least one issue exists while some lines are still pending
- `ready_to_pack` — every line is fully picked
- `ready_to_pack_with_issue` — every line has been handled, but at least one line has a shortage/not-found/damaged/other issue
- `paused`
- `packed`
- `sent`

The operator shelf is persisted separately as `workflowStage`:

- `processing`
- `deferred`
- `packed`
- `sent`

`workflowStage`, detailed `status`, and `ownerTelegramId` are independent dimensions. Claim/takeover changes ownership only and must not move an order between shelves. In particular, a Deferred order remains Deferred while a worker resumes and finishes checking it; it leaves that shelf only on an explicit workflow transition such as packing/sending. A newly recorded problem still routes a Processing order to Deferred. Legacy documents without `workflowStage` are read through the old status mapping and become explicit on their next mutation, so no data migration is required.

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

**Відкласти** releases ownership but keeps every item mark and issue and explicitly places the order on the `deferred` shelf. A later worker continues from the persisted state. Claiming it again does not move it back to `processing`.

### Concurrent editing

Every operational document has a monotonically increasing `revision`. Item updates, release, pack, sent and reopen carry `expectedRevision`. A stale client is rejected instead of overwriting newer work.

Mutations are additionally protected by distributed `withLock` locks. Socket event `baselinker_picking_updated` patches other clients' local picking state without re-fetching the full BaseLinker order list.

### Upstream changes while collecting

BaseLinker is authoritative at all times. Claim, pack and send re-read the exact upstream order at critical boundaries; the journal keeps already opened work fresh between those actions.

When the product composition changes:

- unchanged lines preserve local progress;
- added lines become `pending`;
- changed lines become `pending`;
- removed lines disappear from active items;
- the order receives `upstreamReviewRequired=true` and appears in the separate **Оновлені** filter while preserving its original warehouse shelf.

Journal changes that do not alter product lines (payment, package/label, invoice/receipt, delivery, BaseLinker status or other order data) still mark an already tracked order as Updated so staff can review the new source-of-truth state.

If the exact BaseLinker status is the configured **Cancelled** status, all warehouse mutations are blocked. The card remains visible in Updated with the received BaseLinker status and only the acknowledgement action **Прийнято**. A previously cached-but-never-claimed Intake order follows the same cancellation-attention rule instead of disappearing silently.

If the exact BaseLinker status is the configured **Sent** status, warehouse mutations are also blocked and the order is shown on the Sent shelf only inside the 30-day history window.

### Problems and packing

Saving a problem is a decision for one line, not for the whole order. The worker continues through every remaining `pending` line and records the real local state (`shortage`, `not_found`, `damaged`, `other`) with found quantity/note where applicable.

A problem remains entirely internal to our warehouse workflow. We do not write a Problem status to BaseLinker. A manager can open the source order directly by clicking the compact **Зам-ня №… ↗** link, then edit/cancel/change it in BaseLinker. Journal refresh brings those changes back into our card.

Packing is allowed only when every line has been handled **and no unresolved problem remains**. There is no `allowIssues`/partial-pack bypass in the HTTP or client contract. If a problem is resolved, **Проблему вирішено** sits directly under **Змінити проблему** and resets that line for the correct next warehouse action.

A packed order stores the local packed summary/audit only. Historical schema values for older partial-pack rows remain readable for compatibility, but new runtime writes only full packing.

### Send

`sent` means **our local physical handoff confirmation only**. With the current read-only BaseLinker key it does not change BaseLinker status or courier data. Courier TTN/label continues to be read from BaseLinker.

Admin may reopen `packed`/`sent` local state for correction; the action is audited.

## Operator UI

The BaseLinker page is a warehouse work queue, not a BaseLinker order editor:

- BaseLinker order content/status is upstream source-of-truth; our shelves are local fulfilment state;
- workflow filters include Processing, Deferred, Packed, Sent and the independent **Updated** attention filter;
- **Updated is an overlay**, not a replacement workflow stage: a Packed/Deferred/Sent order can simultaneously require upstream review;
- every order header exposes the compact link **Зам-ня №… ↗** to the exact BaseLinker order; there is no extra large button;
- Cancelled cards are read-only and expose only **Прийнято** as a warehouse mutation;
- Sent upstream history is bounded to 30 days;
- product item controls are disabled when BaseLinker reports a configured terminal upstream status;
- product image allocation is enlarged by ~10% without changing the surrounding flexible grid contract;
- **Проблему вирішено** is immediately below **Змінити проблему**;
- TTN/label stays lazy and BaseLinker-owned.
