'use strict';
/**
 * Чому цей свіп небезпечний, якщо помилитися.
 *
 * Він масовий і його висновок ЗБЕРІГАЄТЬСЯ: рішення «людина вийшла» через
 * grace-період забирає доступ. Тому два правила тут не косметичні, а несучі:
 *
 *   1) невизначений результат (Telegram лежить, бот втратив адмінку) НІКОЛИ не
 *      трактується як відсутність — інакше одна аварія API поклала б усіх
 *      продавців одразу;
 *   2) відсутність визнається лише за ПОВНОГО покриття — якщо хоч одна група не
 *      відповіла, людина ще могла бути саме в ній.
 *
 * Обидва тестуються без Mongo і без Telegram: checkMembership бере бота як
 * аргумент, а decideMembershipAction — чиста функція.
 */
const {
  checkMembership,
  decideMembershipAction,
  GRACE_DAYS,
} = require('../services/membershipSweep');

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUPS = ['-100111', '-100222'];

// Бот, що відповідає за наперед заданою таблицею: статус, або кинутий error.
function fakeBot(byGroup) {
  return {
    calls: [],
    async getChatMember(chatId, userId) {
      this.calls.push(String(chatId));
      const entry = byGroup[String(chatId)];
      if (entry instanceof Error) throw entry;
      return { status: entry };
    },
  };
}

function telegramError(description) {
  const e = new Error(description);
  e.response = { body: { description } };
  return e;
}

describe('checkMembership — присутність vs невизначеність', () => {
  it('присутність в одній групі достатня — другу навіть не питає', async () => {
    const bot = fakeBot({ '-100111': 'member', '-100222': 'left' });
    const r = await checkMembership(bot, GROUPS, '42');

    expect(r.present).toBe(true);
    expect(r.determinate).toBe(true);
    expect(bot.calls).toEqual(['-100111']); // друга група не опитана
  });

  it('«restricted» — це НЕ вихід: обмежений учасник лишається учасником', async () => {
    const bot = fakeBot({ '-100111': 'restricted', '-100222': 'left' });
    const r = await checkMembership(bot, GROUPS, '42');
    expect(r.present).toBe(true);
  });

  it('left у ВСІХ групах → визначена відсутність', async () => {
    const bot = fakeBot({ '-100111': 'left', '-100222': 'kicked' });
    const r = await checkMembership(bot, GROUPS, '42');

    expect(r.present).toBe(false);
    expect(r.determinate).toBe(true);
  });

  it('«user not found» рахується відсутністю — так виглядає той, хто вийшов давно', async () => {
    const bot = fakeBot({
      '-100111': telegramError('Bad Request: user not found'),
      '-100222': telegramError('Bad Request: user not found'),
    });
    const r = await checkMembership(bot, GROUPS, '42');

    expect(r.present).toBe(false);
    expect(r.determinate).toBe(true);
  });

  it('ЖОДНА група не відповіла → невизначено, а не «вийшов»', async () => {
    const bot = fakeBot({
      '-100111': telegramError('Bad Request: chat not found'),
      '-100222': telegramError('Forbidden: bot is not a member of the supergroup chat'),
    });
    const r = await checkMembership(bot, GROUPS, '42');

    expect(r.present).toBe(false);
    expect(r.determinate).toBe(false); // ← ось це і рятує від масового блокування
  });

  it('часткове покриття (одна left, друга впала) → невизначено', async () => {
    const bot = fakeBot({
      '-100111': 'left',
      '-100222': telegramError('ETIMEDOUT'),
    });
    const r = await checkMembership(bot, GROUPS, '42');

    expect(r.present).toBe(false);
    expect(r.determinate).toBe(false); // людина могла бути саме в другій групі
  });
});

describe('decideMembershipAction — grace і його межі', () => {
  const now = new Date('2026-08-05T12:00:00Z');
  const absent = { determinate: true, present: false };
  const present = { determinate: true, present: true };
  const unknown = { determinate: false, present: false };

  it('невизначеність не пише навіть membershipCheckedAt', () => {
    const d = decideMembershipAction({ membershipLeftAt: null, membershipSuspended: false }, unknown, now);
    expect(d.outcome).toBe('unknown');
    expect(d.set).toBeNull();
  });

  it('перша відсутність лише позначає — доступ ще повний', () => {
    const d = decideMembershipAction({ membershipLeftAt: null, membershipSuspended: false }, absent, now);
    expect(d.outcome).toBe('flagged');
    expect(d.set.membershipLeftAt).toEqual(now);
    expect(d.set.membershipSuspended).toBeUndefined();
  });

  it(`на ${GRACE_DAYS - 1}-й день ще чекає`, () => {
    const user = { membershipLeftAt: new Date(now.getTime() - (GRACE_DAYS - 1) * DAY_MS), membershipSuspended: false };
    const d = decideMembershipAction(user, absent, now);
    expect(d.outcome).toBe('waiting');
    expect(d.set.membershipSuspended).toBeUndefined();
  });

  it(`рівно на ${GRACE_DAYS}-й день призупиняє`, () => {
    const user = { membershipLeftAt: new Date(now.getTime() - GRACE_DAYS * DAY_MS), membershipSuspended: false };
    const d = decideMembershipAction(user, absent, now);
    expect(d.outcome).toBe('suspended');
    expect(d.set.membershipSuspended).toBe(true);
    expect(d.history.action).toBe('membership_suspended');
  });

  it('повернення знімає призупинення без участі адміна', () => {
    const user = {
      membershipLeftAt: new Date(now.getTime() - 30 * DAY_MS),
      membershipSuspended: true,
    };
    const d = decideMembershipAction(user, present, now);
    expect(d.outcome).toBe('restored');
    expect(d.set.membershipSuspended).toBe(false);
    expect(d.set.membershipLeftAt).toBeNull();
    expect(d.history.meta.wasSuspended).toBe(true);
  });

  it('повернення в межах grace скидає лічильник — наступний вихід рахується наново', () => {
    const user = { membershipLeftAt: new Date(now.getTime() - 2 * DAY_MS), membershipSuspended: false };
    const d = decideMembershipAction(user, present, now);
    expect(d.outcome).toBe('restored');
    expect(d.set.membershipLeftAt).toBeNull();
  });

  it('присутній і нічого не позначено — жодного зайвого запису в історію', () => {
    const d = decideMembershipAction({ membershipLeftAt: null, membershipSuspended: false }, present, now);
    expect(d.outcome).toBe('ok');
    expect(d.history).toBeNull();
  });

  it('вже призупинений і досі відсутній — не дублює подію в історії', () => {
    const user = { membershipLeftAt: new Date(now.getTime() - 40 * DAY_MS), membershipSuspended: true };
    const d = decideMembershipAction(user, absent, now);
    expect(d.outcome).toBe('suspended');
    expect(d.history).toBeNull();
  });
});
