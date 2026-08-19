'use strict';

const { runAsSchedulerLeader } = require('./schedulerLeader');
const { drainDueDeliveries } = require('./telegramDeliveryLedger');

const TICK_MS = 5 * 1000;
let timer = null;
let running = false;

async function runTelegramDeliveryTick() {
  return runAsSchedulerLeader(
    'telegram-delivery',
    () => drainDueDeliveries({ limit: 100 }),
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
