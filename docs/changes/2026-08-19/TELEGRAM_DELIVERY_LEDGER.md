# Telegram Delivery Ledger — 2026-08-19

## Goal

Replace whole-broadcast flags/counters with durable per-recipient delivery truth for system Telegram notifications.

## Contract

For each system event, the server creates one `TelegramNotificationEvent` and one `TelegramNotificationDelivery` per intended recipient. Delivery identity is DB-backed by a unique index:

```text
eventKey + channel + recipientId
```

Delivery states:

```text
pending -> sending -> sent
                 -> retry_wait -> sending ...
                 -> failed
skipped  (known botBlocked before fan-out)
```

`sent` is written only after Telegram Bot API returns a Message and stores both `message_id` and Telegram `date`.

`sent` does NOT mean read by the person or delivered to a physical device. Bot API exposes no read receipt for ordinary bot messages.

## Crash safety

- fan-out rows and the ordering-session legacy marker are committed in one Mongo transaction;
- each delivery is claimed with a lease;
- a restart/redeploy resumes pending/retry rows instead of treating the whole session as notified;
- an expired `sending` lease is retryable and marks `possibleDuplicate=true` because Telegram has no client idempotency key and the prior network outcome can be ambiguous.

## Retry policy

Retryable:

- HTTP 429, honoring Telegram `retry_after`;
- Telegram/HTTP 5xx;
- network/transport errors such as `EFATAL`, timeout/reset/unreachable.

Permanent 4xx failures are recorded and not looped forever. A known blocked seller remains present in the audience as `skipped`, rather than disappearing before the journal is created.

## Integrated producers

Ledger-backed:

- ordering window opened (`ordering_open`);
- modern SupplementWave `opened`;
- modern SupplementWave `reminder`;
- modern SupplementWave `frozen`;
- modern SupplementWave `cancelled`.

Legacy `waveId=null` SupplementOffer notifications remain on the compatibility notifier. Generic `sendMessageWithRetry` was still hardened for network/5xx/429 behavior there.

## Admin audit

Admin API:

```text
GET /api/admin/telegram-delivery/events
GET /api/admin/telegram-delivery/events/:eventKey
```

For ordering-session private deliveries, detail also provides clearly-derived signals:

- `lastAppOpenedAt` / `appOpenedAfterSend`;
- whether the seller created an Order in that exact source session.

These are contextual signals only, never labelled as read receipts.

The client shows the journal under `Settings -> Delivery Groups -> edit group`.

## Verification in this environment

- server release static: 27/27 PASS;
- Telegram ledger server checker: 20/20 PASS;
- server syntax: 330/330 PASS before this documentation/package-only change;
- client Telegram ledger checker: 7/7 PASS;
- client parser: 243/243 PASS;
- client full static aggregate keeps the same 6 pre-existing failures from the input archive; no new failure was introduced by this change.

Full Vitest/Mongo/Telegram live execution was not claimed because the supplied artifact has no installed project dependencies/test credentials in this environment.
