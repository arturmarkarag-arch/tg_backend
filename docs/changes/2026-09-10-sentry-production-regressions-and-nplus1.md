# 2026-09-10 — Sentry production regressions + N+1 fixes

## Scope

This patch fixes four production findings observed in Sentry without changing frontend contracts or business workflow.

### 1. `GET /api/v1/products/:id/who-ordered` — intermittent HTTP 500

**Sentry:** `ReferenceError: DeliveryGroup is not defined`.

`getActiveDeliveryGroups()` had a cache-first read. While the DeliveryGroup cache was warm, the endpoint worked. On cache miss / expiry / invalidation / process restart it executed `DeliveryGroup.find()` but `routes/products.js` did not import the model. This explains why the failure appeared intermittent.

**Fix:** restore the explicit `DeliveryGroup` model import. The existing strict who-ordered behaviour remains unchanged: corrupt schedules are skipped, no fallback schedule is invented, session identity remains exact, and the route stays read-only.

### 2. `GET /api/baselinker/status` — N+1 account + index-state reads

**Sentry:** repeated `mongoose.BaseLinkerAccount.findOne` and `mongoose.AppSetting.findOne` in one status request.

The route first loaded all BaseLinker accounts, then `publicAccountRuntime()` called `getQueueScope(accountId)` for every account. That re-read each account with `findOne`. `loadIndexState()` then read one AppSetting row per account.

The naive shortcut of deriving scope from the public account DTO is unsafe because the public queue DTO intentionally omits the internal queue `revision`, and that revision is part of `scopeKey` / index-validity checks.

**Fix:**

- load internal account rows once with `BaseLinkerAccount.find(...)` while excluding encrypted tokens;
- derive every queue scope from those already-loaded rows, preserving `queue.revision`;
- load every index-state AppSetting row with one `$in` query;
- convert the raw rows to the existing public DTO only after runtime state has been derived.

**Query shape after patch:** account count no longer changes the number of Mongo round-trips for this read path: one account query + one index-state query.

### 3. `POST /api/picking/tasks/:taskId/complete` — N+1 `Order.updateOne`

**Sentry:** the same item update repeated 14 times in one trace and 46 times in another trace.

`markOrderItemsPacked()` ran one `Order.updateOne()` per packed shop/order. It then ran a second `Order.updateOne()` per order to auto-transition the order to `fulfilled` when every item became terminal. `Promise.all` made these writes concurrent but did not reduce query count.

**Fix:**

- first-stage per-order item mutations become one `Order.bulkWrite(...)`, preserving each order's own delivered quantity and `short_pick` calculation;
- auto-fulfilment becomes one `Order.updateMany(...)` across the touched order IDs after the item writes are visible in the same transaction;
- the terminal predicate is unchanged: packed, cancelled, skipped and voided are terminal;
- the update still runs inside the caller's Mongo session/transaction.

For N shops the DB write round-trips are now constant instead of O(N).

### 4. `POST /api/picking/tasks/:taskId/complete` — N+1 buyer notification reads

**Sentry:** repeated `mongoose.Order.findOne` / `findById` projection of `buyerTelegramId` (14 repeats in the supplied trace).

After updating each order, the service re-read each order separately only to obtain `buyerTelegramId` for the socket event.

**Fix:** one `Order.find({ _id: { $in: [...] } }, 'buyerTelegramId')` projection read is used for all affected orders. Socket payload and event name remain unchanged.

## Behaviour deliberately preserved

- `packedQuantity` remains the actual delivered quantity.
- Partial delivery still sets `shortfallReason = short_pick`.
- `packedBy`, `packedByName`, and `packedAt` are still written.
- An order becomes `fulfilled` only when no non-terminal item remains.
- `skipped` and `voided` remain terminal for fulfilment.
- Picking writes remain within the same Mongo transaction and per-session finalize lock.
- BaseLinker `/status` response shape is unchanged.
- No DB migration and no frontend change are required.

## Regression guard

Run:

```bash
node scripts/checkSentryRegression20260910.js
```

The checker verifies the missing DeliveryGroup import, the bulk BaseLinker status read path, the absence of per-order `Order.updateOne` / `Order.findById` inside `markOrderItemsPacked`, preservation of short-pick/terminal semantics, and Mongo-session propagation.
