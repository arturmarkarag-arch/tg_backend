'use strict';

// Фонові задачі дозамовлень: docs/supplement/readme.md

const { autoCompleteEmptyOffers, reconcilePendingReceipts, freezeOffersForActiveOrderingWindows } = require('./supplementOffers');
const { notifyOffers, findDueReminders } = require('./supplementNotify');
const { runAsSchedulerLeader } = require('./schedulerLeader');

const TICK_MS = 60 * 1000;
let timer = null;
let running = false;

async function runSupplementTick(now = new Date()) {
  try {
    const repaired = await reconcilePendingReceipts();
  } catch (err) {
  }

  try {
    const frozen = await freezeOffersForActiveOrderingWindows(now);
  } catch (err) {
  }

  try {
    const due = await findDueReminders(now);
    if (due.opened.length) await notifyOffers(due.opened, 'opened', { now });
    if (due.reminder.length) await notifyOffers(due.reminder, 'reminder', { now });
  } catch (err) {
  }

  try {
    const closed = await autoCompleteEmptyOffers(now);
  } catch (err) {
  }

  return { ok: true };
}

function startSupplementScheduler() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAsSchedulerLeader('supplement', () => runSupplementTick(), { ttlMs: 5 * 60 * 1000 });
    } finally {
      running = false;
    }
  };

  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  return timer;
}

function stopSupplementScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startSupplementScheduler, stopSupplementScheduler, runSupplementTick, TICK_MS };
