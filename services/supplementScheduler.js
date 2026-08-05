'use strict';

/**
 * Планувальник дозамовлень.
 *
 * Дозамовлення більше НЕ заморожується за таймером. open → frozen виконує
 * вручну склад або адмін. Планувальник лишився для двох фонових задач:
 *   1. довідновити пропозиції проведеної накладної після збою;
 *   2. надсилати нагадування кожні 2 години, поки хвиля open;
 *   3. прибирати frozen-пропозиції без жодної заявки.
 */

const { autoCompleteEmptyOffers, reconcilePendingReceipts } = require('./supplementOffers');
const { notifyOffers, findDueReminders } = require('./supplementNotify');

const TICK_MS = 60 * 1000;
let timer = null;
let running = false;

async function runSupplementTick(now = new Date()) {
  try {
    const repaired = await reconcilePendingReceipts();
    if (repaired) console.log(`[supplement/scheduler] довідновлено накладних: ${repaired}`);
  } catch (err) {
    console.error('[supplement/scheduler] звірка накладних впала:', err?.message);
  }

  try {
    const due = await findDueReminders(now);
    if (due.opened.length) await notifyOffers(due.opened, 'opened', { now });
    if (due.reminder.length) await notifyOffers(due.reminder, 'reminder', { now });
  } catch (err) {
    console.error('[supplement/scheduler] нагадування впали:', err?.message);
  }

  try {
    const closed = await autoCompleteEmptyOffers(now);
    if (closed) console.log(`[supplement/scheduler] авто-завершено ${closed} пропозицій без заявок`);
  } catch (err) {
    console.error('[supplement/scheduler] авто-завершення впало:', err?.message);
  }

  return { ok: true };
}

function startSupplementScheduler() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runSupplementTick();
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
