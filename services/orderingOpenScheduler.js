'use strict';

// Тік раз на хвилину: чи не відкрилось щойно вікно замовлень якоїсь групи.
// Хвилини достатньо — вікно відкривається на рівній хвилині за розкладом, а
// сама розсилка захищена від дублів прапорцем на сесії, не таймінгом тіку.

const { notifyOrderingOpen } = require('./orderingOpenNotify');

const TICK_MS = 60 * 1000;
let timer = null;
let running = false;

async function runOrderingOpenTick(now = new Date()) {
  try {
    return await notifyOrderingOpen({ now });
  } catch (err) {
    console.error('[ordering/scheduler] розсилка старту замовлень впала:', err?.message);
    return { notifiedGroups: 0, sentPrivate: 0, sentGroups: 0 };
  }
}

function startOrderingOpenScheduler() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOrderingOpenTick();
    } finally {
      running = false;
    }
  };

  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  return timer;
}

function stopOrderingOpenScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startOrderingOpenScheduler,
  stopOrderingOpenScheduler,
  runOrderingOpenTick,
  TICK_MS,
};
