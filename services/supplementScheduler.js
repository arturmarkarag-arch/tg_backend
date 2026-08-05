'use strict';

/**
 * Серверний годинник дозамовлень (§6, §18).
 *
 * Джерелом істини про перехід open → frozen є СЕРВЕР, ніколи не таймер у
 * браузері. Цей планувальник:
 *   1. надсилає нагадування, час яких настав (mid / soon);
 *   2. переводить пропозиції, чий closesAt минув, у frozen і повідомляє про це;
 *   3. авто-завершує заморожені пропозиції, які ніхто не замовив (§7).
 *
 * ПІСЛЯ РЕСТАРТУ (§22, тест 18): перший тік іде одразу після старту, тому
 * заморозка все одно настає за closesAt, навіть якщо сервер лежав. Повідомлення
 * не дублюються — це гарантує notifiedTypes у supplementNotify.claimNotification.
 *
 * Інтервал unref()'нутий, як і в services/retention.js: він ніколи не тримає
 * процес живим під час зупинки.
 */

const { freezeDueOffers, autoCompleteEmptyOffers, reconcilePendingReceipts } = require('./supplementOffers');
const { notifyOffers, findDueReminders } = require('./supplementNotify');

// 15 с — дрібніше не має сенсу (дедлайни задаються у хвилинах), крупніше дало б
// помітну паузу між «продавцю вже відмовили за closesAt» і «склад побачив frozen».
// Розбіжності в цій паузі не існує: обидві сторони читають effectiveOfferStatus.
const TICK_MS = 15 * 1000;

let timer = null;
let running = false;

async function runSupplementTick(now = new Date()) {
  // 0. Добити накладні, у яких пропозиції створилися не повністю (падіння між
  //    проведенням і відкриттям). Повторно провести таку накладну неможливо —
  //    вона вже completed, тож це єдиний шлях довести справу до кінця.
  try {
    const repaired = await reconcilePendingReceipts();
    if (repaired) console.log(`[supplement/scheduler] довідновлено накладних: ${repaired}`);
  } catch (err) {
    console.error('[supplement/scheduler] звірка накладних впала:', err?.message);
  }

  // 1. Повідомлення — ДО заморозки, щоб «за 5 хв» не пішло вже після закриття.
  //    'opened' тут ловить стартові пости, які не змогли піти при проведенні.
  try {
    const due = await findDueReminders(now);
    if (due.opened.length) await notifyOffers(due.opened, 'opened', { now });
    if (due.mid.length)    await notifyOffers(due.mid, 'mid', { now });
    if (due.soon.length)   await notifyOffers(due.soon, 'soon', { now });
  } catch (err) {
    console.error('[supplement/scheduler] нагадування впали:', err?.message);
  }

  // 2. Заморозка за дедлайном.
  let frozen = [];
  try {
    frozen = await freezeDueOffers(now);
  } catch (err) {
    console.error('[supplement/scheduler] заморозка впала:', err?.message);
  }

  if (frozen.length) {
    try {
      await notifyOffers(frozen, 'frozen', { now });
    } catch (err) {
      console.error('[supplement/scheduler] повідомлення про заморозку впало:', err?.message);
    }
  }

  // 3. Заморожені без жодної заявки закриваються самі — інакше вони вічно
  //    висіли б у віртуальному блоці і блокували завершення сесії (§17).
  try {
    const closed = await autoCompleteEmptyOffers(now);
    if (closed) console.log(`[supplement/scheduler] авто-завершено ${closed} пропозицій без заявок`);
  } catch (err) {
    console.error('[supplement/scheduler] авто-завершення впало:', err?.message);
  }

  return { frozen: frozen.length };
}

function startSupplementScheduler() {
  const tick = async () => {
    // Захист від накладання: повільний тік (багато Telegram-надсилань) не має
    // запускати другий поверх себе — інакше два проходи змагалися б за claim.
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
