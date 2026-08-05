'use strict';

/**
 * Час, на якому тримаються ПІДКАЗКИ у модалці вибору групи.
 *
 * Правила допуску тут більше немає: усі групи з активними магазинами клікабельні,
 * а стан вікна замовлень — виключно текст для очей працівника (рішення власника
 * 05.08.2026, друга ітерація). Тому й тестувати лишилось саме те, з чого цей
 * текст складається — арифметику розкладу і формат тривалості. Колишній набір
 * тестів на isEligibleState/ELIGIBLE_STATES знято РАЗОМ із самим правилом; якщо
 * захочеться повернути гейт, повертати треба і його тести.
 */

const { humanDuration } = require('../services/supplementTargets');
const {
  getPreviousOrderingCloseAt,
  getOrderingWindowCloseAt,
  getWarsawNow,
} = require('../utils/orderingSchedule');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Живий розклад проєкту: вікно відкривається напередодні о 16:30 і закривається
// в день доставки о 07:30.
const SCHEDULE = { openHour: 16, openMinute: 30, closeHour: 7, closeMinute: 30 };

describe('TRIPWIRE: сервер не вирішує за працівника', () => {
  // Двічі вже було так, що «розумне» правило допуску відбирало в людини вибір і
  // ламало сценарії, яких воно не передбачало. Якщо цей тест упав — хтось
  // повертає гейт. Це може бути свідомим рішенням, але тоді разом із ним треба
  // повертати й тести на кожен стан, а не тільки саму умову.
  const mod = require('../services/supplementTargets');

  it('модуль не експортує правило допуску', () => {
    expect(mod.isEligibleState).toBeUndefined();
    expect(mod.ELIGIBLE_STATES).toBeUndefined();
  });

  it('ціль хвилі — лише група, без сесії', () => {
    // resolveSupplementTarget повертає {deliveryGroupId, state}. Поява
    // orderingSessionId означала б, що хвилю знову прив'язали до доставки.
    expect(String(mod.resolveSupplementTarget)).not.toMatch(/orderingSessionId/);
  });
});

describe('getPreviousOrderingCloseAt — «замовлення закрилися N тому»', () => {
  const now = Date.now();

  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek += 1) {
    it(`день ${dayOfWeek}: попереднє закриття в минулому, наступне в майбутньому`, () => {
      const prev = getPreviousOrderingCloseAt(dayOfWeek, SCHEDULE);
      const next = getOrderingWindowCloseAt(dayOfWeek, SCHEDULE);
      expect(prev.getTime()).toBeLessThanOrEqual(now);
      expect(next.getTime()).toBeGreaterThan(now);
    });

    it(`день ${dayOfWeek}: між сусідніми закриттями рівно тиждень (± година на DST)`, () => {
      const prev = getPreviousOrderingCloseAt(dayOfWeek, SCHEDULE);
      const next = getOrderingWindowCloseAt(dayOfWeek, SCHEDULE);
      const gap = next.getTime() - prev.getTime();
      // Саме через цю годину значення НЕ рахується як «наступне − 7 днів»:
      // на переході DST така арифметика показала б «закрилося 4 години тому»
      // замість трьох.
      expect(Math.abs(gap - 7 * DAY)).toBeLessThanOrEqual(HOUR);
    });
  }

  it('у день доставки до 07:30 попереднє закриття — тиждень тому, а не сьогодні', () => {
    const { dayOfWeek, hour, minute } = getWarsawNow();
    const beforeClose = hour * 60 + minute < 7 * 60 + 30;
    if (!beforeClose) return; // тест має сенс лише вранці — інакше просто пропускаємо

    const prev = getPreviousOrderingCloseAt(dayOfWeek, SCHEDULE);
    expect(Date.now() - prev.getTime()).toBeGreaterThan(6 * DAY);
  });
});

describe('humanDuration — так, як це вимовляє людина', () => {
  it('менше хвилини не перетворюється на «0 хвилин»', () => {
    expect(humanDuration(10 * 1000)).toBe('менше хвилини');
  });

  it('хвилини відмінюються', () => {
    expect(humanDuration(1 * MIN)).toBe('1 хвилину');
    expect(humanDuration(3 * MIN)).toBe('3 хвилини');
    expect(humanDuration(45 * MIN)).toBe('45 хвилин');
    expect(humanDuration(11 * MIN)).toBe('11 хвилин');
  });

  it('рівні години йдуть без хвилин', () => {
    expect(humanDuration(3 * HOUR)).toBe('3 години');
    expect(humanDuration(1 * HOUR)).toBe('1 годину');
  });

  it('неповні години показують і хвилини', () => {
    expect(humanDuration(2 * HOUR + 15 * MIN)).toBe('2 години 15 хвилин');
  });

  it('від доби рахуємо днями', () => {
    expect(humanDuration(4 * DAY)).toBe('4 дні');
    expect(humanDuration(7 * DAY)).toBe('7 днів');
  });

  it('відʼємний час не дає «-5 хвилин»', () => {
    expect(humanDuration(-5 * MIN)).toBe('менше хвилини');
  });
});
