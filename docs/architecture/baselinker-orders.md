# BaseLinker fulfilment integration

## Boundary

BaseLinker is an external live order source. Its orders are **not** inserted into the existing `Order`, `OrderingSession`, `PickingTask` or delivery-group workflow. Those models belong to the seller -> group -> warehouse-session process and have different invariants.

The integration is split into two authorities:

- **BaseLinker** is authoritative for the order, customer, product snapshot, current catalog data, courier packages and labels.
- **Our MongoDB** is authoritative only for our own fulfilment progress: who is collecting an order, which lines were found, shortages/problems, packed markers and audit history. A local `sent` state is valid only after the configured BaseLinker Sent status has been confirmed by an exact upstream reread.

The BaseLinker token exists only on the server as `BASELINKER_API_TOKEN`. Order reads remain source-of-truth reads from BaseLinker. The one intentional order write is the operator action **Відправив**: the server calls `setOrderStatus` for that exact `order_id`, then performs exact `getOrders(order_id)` verification before persisting local Sent. No other order-field/status mutation is allowed by this module.

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

Without the explicit key, the server fingerprints the **entire** token into an opaque scope. API tokens are credentials, not a documented account identity, so no substring/prefix is interpreted as an account ID. Token rotation without `BASELINKER_ACCOUNT_KEY` therefore starts a new isolated namespace rather than risking a cross-account merge. The secret token itself is never persisted as the scope.

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
- **Sent / Wysłano** — an upstream status and a 30-day history shelf based on BaseLinker's `date_in_status`, not the unrelated confirmation date. A manual BaseLinker transition to this status is materialised locally as Sent; the local **Відправив** action writes exactly this configured status upstream and verifies it before local persistence.
- **Cancelled / Anulowane** — never mass-scanned historically. It is used as a terminal signal when journal/exact refresh shows that an order already known to our queue moved to the selected cancelled status.

The old single `statusId` setting is treated only as a migration fallback for Intake. The queue is not considered configured until Sent and Cancelled are also selected, and all three IDs must be different. The API token remains server-side.

Admin-only routes: `GET/POST /admin/baselinker-settings` and `GET /admin/baselinker-settings/statuses`. Status options come from `getOrderStatusList`; saves are validated against the current BaseLinker list and persisted in an account-scoped `AppSetting` namespace based on `baselinker.queueSettings.v1`. Every save changes a revision/scope key so an older scan cannot publish into a newer configuration or account.

The scheduled full reconciliation scans only two upstream subsets:

1. all Intake orders, including unconfirmed rows, paged with BaseLinker's `id_from` cursor and no date boundary;
2. all orders in the exact Sent status, paged by `id_from`; the server then keeps only rows whose BaseLinker `date_in_status` is inside the 30-day history window. BaseLinker has no `date_in_status` request filter, so using `date_confirmed_from` here would incorrectly hide old orders moved to Sent recently.

Cancelled is intentionally not a third historical scan. Journal events refresh exact `order_id`s. Before an exact refresh is published, the server remembers whether that order was already present in our cache. If such a known order is now Cancelled, it is materialised as an **Updated** attention record even when nobody had claimed it yet. The card is read-only until an operator acknowledges it with **Прийнято**.

The periodic full reconciliation is also a **status-loss detector**, not merely a cache refresh. If an order that was previously known in Intake/Sent disappears from both status-filtered scans, the server performs exact `getOrders(order_id)` reads for a bounded batch of those disappeared IDs. That exact result decides whether the order is now Cancelled, Sent, another status, or missing/deleted. The stale cached status is never allowed to decide. Remaining recovery work is persisted as a health counter and retried on later reconciliation passes.

`GET /orders` reads MongoDB only and never starts an upstream scan. It returns `baselinker_queue_not_configured` until all three statuses are selected and `baselinker_queue_warming` until a complete scoped snapshot exists. A truncated BaseLinker scan is rejected before sweep/publication.

The journal is the incremental path. It is polled in the background (15 seconds by default). For every BaseLinker event that can change something visible or operational on an order (products, payment, order data/status, delivery, package/label state, invoice, receipt, merge/split/copy), the server fetches only the affected `order_id` through exact `getOrders(order_id)`, reconciles the current snapshot, and marks already locally tracked work as **Updated**. Event type `18` is a status transition; its `object_id` is the BaseLinker status ID. Blacklist-only events are ignored.

BaseLinker documents that `getJournalList` can return an empty list when the method is not enabled for the account. An empty bootstrap therefore sets a visible `journalPossiblyDisabled` health state and the system continues with periodic reconciliation instead of pretending near-live sync is healthy. While journal health is degraded, the reconciliation cadence tightens to `BASELINKER_DEGRADED_RECONCILE_MS` (60 seconds by default, bounded to at least 30 seconds); a healthy journal keeps the slower five-minute safety sweep. The fallback still uses exact `order_id` reads for orders that disappear from known queue statuses.

BaseLinker remains source of truth. Local progress and acknowledgement live only in `BaseLinkerPickingOrder`; local order content/status never overrides an exact upstream result.

`/status` exposes the three configured status IDs/names, fixed `sentLookbackDays=30`, cache/journal readiness, whether the journal scheduler is actually started in this process, journal cursor/poll/last-change health, degraded reconciliation cadence, fallback reconciliation backlog and last sync error. Errors persist across ticks/restarts with bounded retry backoff.

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

No `createPackage`, package deletion or shipment mutation exists in this module. The only upstream order mutation is the separately guarded `setOrderStatus` used by **Відправив**.

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

Tracked work also has `lastUpstreamVerifiedAt`. Interactive warehouse mutations refuse known non-Intake states and periodically reverify the exact `order_id` (15-second freshness window by default); heartbeat performs a forced exact check. This prevents a silent journal/cache lag from allowing continued picking after BaseLinker has already cancelled/sent/moved the order.

A claim has `lastActivityAt`; the client sends a heartbeat every minute. The default stale timeout is ten minutes (`BASELINKER_PICKING_CLAIM_STALE_MS` can override it, minimum two minutes).

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

`sent` is **upstream-verified**, not an independent local truth. **Відправив** performs `setOrderStatus(exact order_id, configured sentStatusId)` and then exact `getOrders(order_id)`. Local `sent` is persisted only if BaseLinker now returns that exact Sent status. If the write response is ambiguous or verification still shows another status, local Sent is not committed.

A manual status change to Sent in BaseLinker is also reconciled into local Sent. If BaseLinker later moves the order back to Intake, local Sent is reverted to the appropriate packed/working state instead of surviving as stale truth. Courier TTN/label remains read from BaseLinker.

Admin reopen is still audited, but upstream status remains authoritative and blocked states cannot be locally forced into actionable Intake.

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
