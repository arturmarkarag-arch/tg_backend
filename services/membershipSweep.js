'use strict';

const GroupMember = require('../models/GroupMember');
const User = require('../models/User');

/**
 * Щоденна звірка живого членства в робочих Telegram-групах + призупинення
 * доступу з відтермінуванням.
 *
 * ЧОМУ ЦЕ ПОТРІБНО ОКРЕМИМ СВІПОМ, а не самих лише подій `chat_member`:
 * пасивний трекінг (services/groupMemberSync) наповнює GroupMember тільки коли
 * людина щось написала в чат або коли прилетів `chat_member`. Подія губиться
 * назавжди, якщо в момент виходу бот не був адміном групи або вебхук лежав, а
 * методу «дай список усіх учасників» у Bot API не існує взагалі — є лише
 * getChatMemberCount і getChatAdministrators. Аудит живої БД (2026-08-05) показав
 * результат: 15 продавців зі 153 не мали жодного запису GroupMember (бот їх ніколи
 * не бачив), а 22 вже стояли з left=true, зберігаючи повний доступ. Єдиний
 * надійний спосіб — питати getChatMember поіменно, і саме це робить свіп.
 *
 * FAIL-OPEN — і це головна відмінність від telegramBot.isUserInAllowedGroup,
 * яка fail-CLOSED. Там гейт разовий і на вході: не змогли підтвердити — не
 * пускаємо, ціна помилки нульова. Тут навпаки: свіп масовий і його висновок
 * зберігається. Якби він був fail-closed, одна недоступність Telegram API або
 * втрата ботом прав адміна позначила б УСІХ продавців як таких, що вийшли, і
 * через grace-період система сама себе заблокувала б. Тому: невизначений
 * результат ніколи не рухає membershipLeftAt — користувача просто пропускаємо
 * до наступного разу.
 *
 * ВІДСУТНІСТЬ вимагає ПОВНОГО покриття: щоб визнати людину такою, що вийшла,
 * КОЖНА дозволена група має відповісти визначено. Присутності ж достатньо в
 * одній — тоді решту навіть не питаємо.
 */

const GRACE_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = GRACE_DAYS * DAY_MS;

// Пауза між викликами getChatMember. Telegram документує ~30 запитів/с лише для
// надсилання повідомлень; для read-методів тримаємо помітно нижче — 150 мс дає
// ≈6.7 запитів/с, тобто повний прохід по 153 продавцях × 2 групи ≈ 45 секунд.
const CALL_SPACING_MS = 150;

// Свіп важкий (сотні викликів у Telegram), тому після рестарту процесу він не
// повторюється, якщо попередній був нещодавно. Без цього кожен деплой на Render
// = зайвий повний прохід.
const MIN_SWEEP_GAP_MS = 12 * 60 * 60 * 1000;

// 'restricted' (замучений/обмежений) — це НЕ вихід з групи, людина досі учасник,
// тому тут вона рахується присутньою. Це свідомо розходиться з
// isUserInAllowedGroup, де 'restricted' відхиляється: там вирішується «чи можна
// зареєструвати нового», і обмежений учасник цю планку не проходить. Тут же
// питання інше — «чи він пішов», — і відповідь «ні». Збігається з
// groupMemberSync.handleChatMemberUpdate.
const PRESENT_STATUSES = ['member', 'administrator', 'creator', 'restricted'];

// Telegram каже «user not found», коли telegramId чату невідомий — так виглядає
// і той, хто вийшов давно, і той, кого там ніколи не було. Для нашого питання
// обидва випадки означають одне: зараз не учасник. Усе інше (чат не знайдено,
// бот не в групі, 403, 429, мережа, 5xx) — це проблема НАША, а не користувача,
// і вона має лишатися невизначеністю.
const ABSENT_ERROR_RE = /user not found|PARTICIPANT_ID_INVALID|USER_ID_INVALID|user_not_participant/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describeError(err) {
  return String(err?.response?.body?.description || err?.message || err || '');
}

function retryAfterSeconds(err) {
  const n = Number(err?.response?.body?.parameters?.retry_after);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Одна група, один користувач.
 * @returns {{ known: boolean, present: boolean, status: string, error?: string }}
 *          known=false означає «ми не дізналися», а не «його немає».
 */
async function checkOneGroup(bot, groupChatId, telegramId) {
  try {
    const member = await bot.getChatMember(String(groupChatId), Number(telegramId));
    const status = String(member?.status || '');
    return { known: true, present: PRESENT_STATUSES.includes(status), status };
  } catch (err) {
    const wait = retryAfterSeconds(err);
    if (wait) {
      // 429 — Telegram сам сказав, скільки чекати. Пересидимо і спробуємо ще раз
      // один раз; якщо знову ліміт — лишаємо невизначеність, свіп не поспішає.
      await sleep((wait + 1) * 1000);
      try {
        const member = await bot.getChatMember(String(groupChatId), Number(telegramId));
        const status = String(member?.status || '');
        return { known: true, present: PRESENT_STATUSES.includes(status), status };
      } catch (err2) {
        return { known: false, present: false, status: '', error: describeError(err2) };
      }
    }
    const msg = describeError(err);
    if (ABSENT_ERROR_RE.test(msg)) {
      return { known: true, present: false, status: 'not_found' };
    }
    return { known: false, present: false, status: '', error: msg };
  }
}

/**
 * Живий стан членства по всіх дозволених групах.
 * @returns {{ determinate: boolean, present: boolean, results: Array }}
 */
async function checkMembership(bot, groupIds, telegramId) {
  const results = [];
  for (const gid of groupIds) {
    const r = await checkOneGroup(bot, gid, telegramId);
    results.push({ groupChatId: String(gid), ...r });
    if (r.known && r.present) break; // одної групи достатньо — решту не питаємо
    await sleep(CALL_SPACING_MS);
  }

  const present = results.some((r) => r.known && r.present);
  // Присутність доводиться однією групою; відсутність — лише повним покриттям.
  const allAnswered = results.length === groupIds.length && results.every((r) => r.known);
  return { determinate: present || allAnswered, present, results };
}

/** Синхронізує GroupMember з тим, що щойно сказав Telegram. */
async function syncGroupMemberRows(telegramId, user, results, now) {
  const ops = results
    .filter((r) => r.known)
    .map((r) => ({
      updateOne: {
        filter: { groupChatId: r.groupChatId, telegramId: String(telegramId) },
        update: {
          $set: { left: !r.present, telegramStatus: r.status || (r.present ? 'member' : 'not_found'), statusCheckedAt: now, statusCheckError: '' },
          // Імена лише при створенні — щоб свіп не затирав те, що прийшло з
          // живого чату (там вони свіжіші й з username).
          $setOnInsert: {
            username: '',
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            isBot: false,
            joinedAt: null,
            lastSeenAt: now,
          },
        },
        upsert: true,
      },
    }));
  if (ops.length) await GroupMember.bulkWrite(ops, { ordered: false });
}

/**
 * ЧИСТЕ рішення: що зробити з користувачем за результатом перевірки. Без БД —
 * саме тут живе вся grace-арифметика, і саме її треба вміти перевірити тестом,
 * не піднімаючи Mongo.
 *
 * @returns {{ outcome: string, set: object|null, history: object|null }}
 *          set=null означає «не чіпати документ узагалі».
 */
function decideMembershipAction(user, check, now) {
  // Невизначеність нічого не рухає — навіть membershipCheckedAt, щоб поле чесно
  // показувало давність ОСТАННЬОЇ визначеної відповіді.
  if (!check.determinate) return { outcome: 'unknown', set: null, history: null };

  const base = { membershipCheckedAt: now };

  if (check.present) {
    if (!user.membershipLeftAt && !user.membershipSuspended) {
      return { outcome: 'ok', set: base, history: null };
    }
    // Повернувся (або попередній висновок був хибним) — знімаємо все автоматично.
    return {
      outcome: 'restored',
      set: { ...base, membershipLeftAt: null, membershipSuspended: false, membershipSuspendedAt: null },
      history: {
        action: 'membership_restored',
        meta: { wasSuspended: Boolean(user.membershipSuspended), leftAt: user.membershipLeftAt || null },
      },
    };
  }

  // Відсутній у всіх дозволених групах.
  if (!user.membershipLeftAt) {
    // Перша фіксація: лише прапорець, доступ поки повний.
    return {
      outcome: 'flagged',
      set: { ...base, membershipLeftAt: now },
      history: { action: 'membership_left_flagged', meta: { graceDays: GRACE_DAYS } },
    };
  }

  const overdue = now.getTime() - new Date(user.membershipLeftAt).getTime() >= GRACE_MS;
  if (overdue && !user.membershipSuspended) {
    return {
      outcome: 'suspended',
      set: { ...base, membershipSuspended: true, membershipSuspendedAt: now },
      history: {
        action: 'membership_suspended',
        meta: { leftAt: user.membershipLeftAt, graceDays: GRACE_DAYS },
      },
    };
  }

  // Або ще в межах grace, або вже призупинений — просто освіжаємо давність.
  return { outcome: user.membershipSuspended ? 'suspended' : 'waiting', set: base, history: null };
}

/**
 * Застосовує рішення до документа.
 * @returns {'ok'|'unknown'|'flagged'|'waiting'|'suspended'|'restored'}
 */
async function applyMembershipResult(user, check, now) {
  const { outcome, set, history } = decideMembershipAction(user, check, now);
  if (!set) return outcome;

  const update = { $set: set };
  if (history) {
    // $slice -20 обов'язковий: User.history вже має обмеженого письменника
    // (services/migrateSellerShop), і другий, необмежений, тихо роздував би
    // документи користувачів щодня.
    update.$push = {
      history: {
        $each: [{ at: now, by: 'system', byName: 'membership-sweep', byRole: 'system', ...history }],
        $slice: -20,
      },
    };
  }
  await User.updateOne({ _id: user._id }, update);
  return outcome;
}

/**
 * Повний прохід. Свідомо послідовний: паралелити виклики до Telegram означає
 * гарантовано впертися в 429 і отримати купу невизначених результатів.
 *
 * Обмежений роллю 'seller': адміністратор або складський працівник, якого
 * випадково немає в чаті, не має втрачати доступ — цим можна замкнути себе
 * зовні системи.
 */
async function runMembershipSweep({ telegramIds = null } = {}) {
  const { getBot } = require('../telegramBot');
  const { getAllowedGroupIds } = require('../routes/admin');

  const bot = getBot();
  if (!bot) return { skipped: 'bot_unavailable' };

  const groupIds = await getAllowedGroupIds();
  if (!groupIds.length) return { skipped: 'no_allowed_groups' };

  const filter = { role: 'seller' };
  if (telegramIds) filter.telegramId = { $in: telegramIds.map(String) };
  const users = await User.find(
    filter,
    'telegramId firstName lastName membershipLeftAt membershipSuspended membershipCheckedAt',
  ).lean();

  const stats = { checked: 0, ok: 0, unknown: 0, flagged: 0, waiting: 0, suspended: 0, restored: 0 };
  const now = new Date();

  for (const user of users) {
    const check = await checkMembership(bot, groupIds, user.telegramId);
    stats.checked += 1;

    if (check.determinate) {
      await syncGroupMemberRows(user.telegramId, user, check.results, now).catch((e) =>
        console.warn('[membershipSweep] GroupMember sync failed:', e.message));
    }

    const outcome = await applyMembershipResult(user, check, now);
    stats[outcome] = (stats[outcome] || 0) + 1;

    await sleep(CALL_SPACING_MS);
  }

  return stats;
}

/** Коли востаннє хоч когось перевіряли — свіжість даних без окремого сховища. */
async function getLastSweepAt() {
  const [newest] = await User.find(
    { role: 'seller', membershipCheckedAt: { $ne: null } },
    'membershipCheckedAt',
  ).sort({ membershipCheckedAt: -1 }).limit(1).lean();
  return newest?.membershipCheckedAt || null;
}

function startMembershipSweepScheduler() {
  const runOnce = async () => {
    try {
      const last = await getLastSweepAt();
      if (last && Date.now() - new Date(last).getTime() < MIN_SWEEP_GAP_MS) {
        return; // нещодавно вже ганяли — рестарт процесу не привід повторювати
      }
      const stats = await runMembershipSweep();
      if (stats.skipped) {
        console.warn(`[membershipSweep] пропущено: ${stats.skipped}`);
        return;
      }
      console.log(
        `[membershipSweep] перевірено ${stats.checked}: у групі ${stats.ok}, повернулись ${stats.restored}, ` +
        `позначено ${stats.flagged}, чекають ${stats.waiting}, призупинено ${stats.suspended}, невизначено ${stats.unknown}`,
      );
    } catch (err) {
      console.error('[membershipSweep] прохід впав:', err?.message);
    }
  };
  runOnce();
  const timer = setInterval(runOnce, DAY_MS);
  timer.unref();
  return timer;
}

module.exports = {
  runMembershipSweep,
  checkMembership,
  decideMembershipAction,
  applyMembershipResult,
  getLastSweepAt,
  startMembershipSweepScheduler,
  GRACE_DAYS,
};
