'use strict';

const { runAsSchedulerLeader } = require('./schedulerLeader');
const { drainDueDeliveries } = require('./telegramDeliveryLedger');
const { drainDueReceiptNewProductPublications } = require('./receiptNewProductTelegram');

const TICK_MS = 5 * 1000;
let timer = null;
let running = false;

async function runTelegramDeliveryTick() {
  return runAsSchedulerLeader(
    'telegram-delivery',
    async () => {
      const notifications = await drainDueDeliveries({ limit: 100 });
      const newProducts = await drainDueReceiptNewProductPublications({ limit: 20 });
      return { notifications, newProducts };
    },
    { ttlMs: 10 * 60 * 1000 },
  );
}

function startTelegramDeliveryScheduler() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runTelegramDeliveryTick();
    } catch (err) {
      console.warn('[telegram-delivery] scheduler tick failed', err?.message || err);
    } finally {
      running = false;
    }
  };
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  return timer;
}

function stopTelegramDeliveryScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  TICK_MS,
  runTelegramDeliveryTick,
  startTelegramDeliveryScheduler,
  stopTelegramDeliveryScheduler,
};
