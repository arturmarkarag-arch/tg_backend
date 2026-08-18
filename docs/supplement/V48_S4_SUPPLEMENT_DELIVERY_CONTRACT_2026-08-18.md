# V48.S4 — Supplement Delivery Contract

Date: 2026-08-18  
Status: **APPROVED BUSINESS CONTRACT — implementation is staged; gaps are listed explicitly**

## Purpose

Supplement is an emergency addition to one delivery group's existing order while
that delivery can still physically receive more goods. It is not a second ordinary
catalogue and it is not a channel for selling the same ReceiptItem to later groups.

```text
Group A current delivery
  -> receives the just-arrived item through supplement

Groups B / C / D
  -> receive any warehouse remainder through the ordinary Block catalogue
  -> subject to the normal seller-cycle cutoff
```

## Three independent state axes

Product state, ordering-session state and group eligibility must never be collapsed
into one status.

### 1. ReceiptItem supplement lifecycle

```text
WAITING_RECEIPT -> READY -> OPEN -> FROZEN -> COMPLETED
                           \----------cancel----------> READY
```

- `WAITING_RECEIPT`: supplement route selected, receiving document not completed.
- `READY`: publishable into one eligible target session.
- `OPEN`: sellers may create/update/cancel their requests.
- `FROZEN`: seller writes are closed and warehouse packing is allowed.
- `COMPLETED`: supplement life of this ReceiptItem is final.
- `CANCELLED` belongs to one publication revision, not to the ReceiptItem UI state.
  A cancelled OPEN or FROZEN publication releases the item back to READY when its
  route still contains supplement and no completed lifecycle exists.
- Freezing with zero live requests must not manufacture COMPLETED; it releases the item.

At most one OPEN/FROZEN publication of one ReceiptItem may exist across all targets.
Cancellation permits a clean sequential retarget. Simultaneous multi-group demand is forbidden.

### 2. OrderingSession state

Two existing axes remain independent:

```text
orderingWindow: UPCOMING -> OPEN -> CLOSED
pickingStatus:  PENDING -> CONFIRMED -> IN_PROGRESS -> COMPLETED
```

Closing the ordinary ordering window does not close supplement. That is the main
period in which the emergency addition is useful.

### 3. Delivery dispatch state

Business eligibility ends when the delivery physically leaves, not merely when
warehouse tasks happen to reach `pickingStatus=COMPLETED`.

The session therefore requires a durable dispatch fact:

```text
dispatchStatus: NOT_DISPATCHED -> DISPATCHED
```

- `NOT_DISPATCHED`: the exact current delivery may accept/reopen supplement work.
- `DISPATCHED`: supplement publication/reopen is final-closed for this session.

Until this fact is implemented, the application cannot truthfully distinguish
"warehouse finished packing" from "delivery already departed". It must not infer
dispatch from local time or an elapsed-minute heuristic.

## Group supplement eligibility

DeliveryGroup is configuration (schedule, shops), not mutable lifecycle authority.
Its UI/read model may expose a derived current-cycle projection, but authority stays
on the exact OrderingSession.

```text
supplement target is eligible iff:
  exact current OrderingSession exists
  AND its scheduled cycle has started
  AND dispatchStatus != DISPATCHED
  AND the selected ReceiptItem is READY
```

- A future pre-created session is not eligible.
- Closing ordinary order acceptance does not make the session historical.
- A session is historical after the group rolls to another current delivery cycle;
  new work must never be attached to that old session.
- Working target selectors hide targets with `readyCount=0`.
- Publish pins `DeliveryGroup + exact OrderingSession` and revalidates both under
  the session lifecycle lock.

## Containers, revisions and requests

```text
DeliveryGroup + OrderingSession
  -> one stable SupplementWave container
  -> one SupplementOffer slot per ReceiptItem
  -> revision 1..N
  -> SupplementRequest identity = offerId + revision + shopId
```

- Reopening the same cancelled slot increments revision.
- A new target after cancellation gets a slot in that target's container.
- New revision starts with zero current requests.
- Old requests and packed facts stay historical and never become current again.
- Metadata correction for the same product preserves active request quantities and
  updates current OPEN/FROZEN projections; terminal revision snapshots remain immutable.

## Completion and the ordinary remainder

`COMPLETED` is final for the ReceiptItem supplement lifecycle. The same ReceiptItem
cannot be supplemented into another group after completion.

If `routing.warehouse=true`, the remaining physical goods continue as the warehouse
Product. After real Block placement they enter the ordinary catalogue. Later groups
see them only when the existing cycle-cutoff says the Product existed before their
cycle opened.

If `routing.warehouse=false`, no warehouse Product or Block membership exists.

## Artifact and page projection

| Receipt route | Нові товари | Товари Магазинів | Товари Складу | Ordinary seller catalogue |
|---|---|---|---|---|
| supplement only | yes | standalone ShopProduct | no | no |
| supplement + warehouse | yes after Block placement | Product mirror | after Block placement | cycle cutoff |
| warehouse only | yes after Block placement | Product mirror | after Block placement | cycle cutoff |

`supplement only` must create a receipt-owned standalone ShopProduct with
`orderingEnabled=false`. Staff can see/edit it in "Товари Магазинів" and it can
participate in the "Нові товари" receipt-arrival union, but sellers cannot order it
through the ordinary catalogue.

## Seller presentation boundary

Supplement may reuse the ordinary ProductCarousel visual component, but never its
business identity or mutation flow:

```text
ordinary order -> productId + ordinary order API
supplement     -> offerId + supplement request API
```

Seller-facing copy shows only operational facts: supplement badge, current state,
price, own quantity and action. Architecture explanations belong in code/docs, not
inside the product card.

## Explicit implementation gaps at contract adoption

1. OrderingSession has no durable `dispatchStatus`; current UI explicitly admits
   that actual departure is not tracked.
2. `supplement only` currently creates neither warehouse Product nor standalone
   ShopProduct, so it is absent from "Нові товари" and "Товари Магазинів".
3. Existing source-contract tests still encode earlier S3/multi-target wording and
   must be updated only when the corresponding authority is migrated.

These gaps are not silently claimed as complete by this document.
