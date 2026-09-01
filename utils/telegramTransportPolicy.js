'use strict';

// Keep every individual Bot API request comfortably below the per-item lock TTL.
// A timeout after Telegram accepted a CREATE is still treated as delivery ambiguity;
// this constant only bounds how long our process may hold a transport lock.
const TELEGRAM_REQUEST_TIMEOUT_MS = 45 * 1000;

// One distributed lane serializes every Telegram sender in the application.
// The worker stops claiming NEW work before this budget expires, leaving enough
// headroom for the last 45s request + DB finalization before the lane TTL expires.
const TELEGRAM_DELIVERY_LANE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_DELIVERY_BATCH_BUDGET_MS = 8 * 60 * 1000;

function telegramBatchBudgetExceeded(startedAtMs, nowMs = Date.now()) {
  return Number(nowMs) - Number(startedAtMs) >= TELEGRAM_DELIVERY_BATCH_BUDGET_MS;
}

module.exports = {
  TELEGRAM_REQUEST_TIMEOUT_MS,
  TELEGRAM_DELIVERY_LANE_TTL_MS,
  TELEGRAM_DELIVERY_BATCH_BUDGET_MS,
  telegramBatchBudgetExceeded,
};
