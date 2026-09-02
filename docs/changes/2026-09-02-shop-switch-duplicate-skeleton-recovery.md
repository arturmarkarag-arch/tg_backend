# Shop switch duplicate/skeleton recovery — 2026-09-02

## Problem
A shop change could surface the global Mongo `duplicate_key` message and, after an ambiguous/failed response, leave Mini App on an empty catalogue skeleton. Browser-admin realtime recovery also incorrectly used the Telegram-only profile endpoint.

## Client contract
- Browser sessions reconcile with `GET /v1/auth/me`; Telegram sessions use `/v1/telegram/me`.
- `user_shop_changed` re-reads authoritative profile + ordering status and applies them as one context.
- A failed direct switch performs the same reconciliation before deciding that the switch failed.
- If server authority shows the requested target shop was committed, the modal closes and the catalogue restores normally.
- If assignment did not change, existing catalogue state is not unnecessarily cleared.
- A real scope change resets session restoration so the canonical catalogue/deep-link restore path hydrates the new shop.

## Server contract
- Assignment transaction retries once, while holding the same user-assignment lock, when a race hits the OrderingSession or active-Order unique key.
- A persistent target active-order collision becomes `shop_switch_order_conflict`, not generic `duplicate_key`.
- A persistent session race becomes `ordering_session_changed`.
- `/v1/telegram/me/shop` has a final fail-closed `shop_switch_conflict` backstop for any other duplicate inside the assignment transaction.
- Seller transfer-request duplicate races become `transfer_already_pending`.

## Manual acceptance
1. Admin/browser: switch A -> B -> A, including groups whose ordering windows are closed.
2. Repeat the same target quickly / double-click save. Exactly one authoritative assignment must remain.
3. After any 409, close the modal and return to Products: no indefinite skeleton; either old or target shop must render from server authority.
4. Seller: create one pending transfer request, then attempt a second. UI must say an active request already exists, never generic duplicate-key.
5. With two browser tabs, switch the same account concurrently. One may receive a conflict, but both tabs must recover to the same server-authoritative shop after realtime/reload.
