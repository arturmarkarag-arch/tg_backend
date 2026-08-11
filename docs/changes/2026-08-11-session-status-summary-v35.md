# V35 — session status / summary consistency

Date: 2026-08-11

## Fixed

1. `SessionStatusHeader` expected counters that the server never returned (`closedOrderCount`, `archivedProductCount`, etc.), while `buildSessionSummary()` returned only `orderCount`. This produced `0/0` on a fully completed cycle.
2. Delivery-group selector rendered `Збирається` from `hasRelocatedOrders` (closed-window active-order heuristic), not from the actual `OrderingSession.phase`. The selector and session header could therefore disagree.
3. DeliveryGroup schedule edits treated terminal history as live work: any historical Order/Task or `pickingStatus=completed` blocked changes forever. V35 blocks only active Orders (`new|in_progress`), active Tasks (`pending|locked`), and live picking lifecycle (`confirmed|in_progress`). Target-session collision and completed-cycle reopen guards stay intact.
4. Schedule edits after a completed cycle no longer append a misleading `rescheduled` event to that historical completed session; the change is future configuration.
5. Human session numbering is already fixed in V30 runtime. Historical `seq:null` requires the existing one-time `backfillSessionSeq.js` migration; V35 does not invent numbers in the UI.

## Canonical completed-session summary

- `processedProductCount / totalProductCount` = completed PickingTasks / all PickingTasks in that session.
- `completedOrderCount / totalOrderCount` = terminal operational Orders / all non-expired Orders in that session.
- `archivedProductCount / archiveRequiredProductCount` = successfully reconciled OOS/system-archive tasks / tasks that required archival.
- `expired` Orders are historical/admin-terminal and intentionally excluded from the delivery-cycle denominator.

Example matching the 2026-08-08 Monday cycle:

- tasks: 540 completed = 527 packed + 13 OOS
- operational orders: 34 fulfilled (plus 1 expired, excluded)
- expected UI: `Опрацьовано товарів 540/540`, `Завершено замовлень 34/34`, `Архівовано товарів 13/13`

## Source of truth

`services/sessionPresentation.js` is now shared by:

- `POST /api/picking/start-session`
- `GET /api/picking/queue-stats`
- `GET /api/delivery-groups`

So the delivery-group badge and picking-session header derive phase from the same implementation.
