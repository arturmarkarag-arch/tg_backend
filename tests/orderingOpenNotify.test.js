'use strict';

const {
  buildGroupText,
  buildPrivateText,
  deliveryDateLabel,
  closePhrase,
  isFreshOpen,
  MAX_LATENESS_MS,
} = require('../services/orderingOpenNotify');
const { DAY_FULL_UK } = require('../utils/orderingSchedule');

const SCHEDULE = { openHour: 16, openMinute: 30, closeHour: 7, closeMinute: 30 };

describe('розсилка «замовлення відкрито»', () => {
  const appUrl = 'https://t.me/example_bot/app';

  it('пост у робочий чат називає групу — чат спільний на всіх', () => {
    const text = buildGroupText({
      groupName: 'Четвер',
      deliveryLabel: 'четвер, 13.08',
      closeLabel: 'завтра о 07:30',
      appUrl,
    });
    expect(text).toContain('Четвер');
    expect(text).toContain('Доставка — четвер, 13.08.');
    expect(text).toContain('Замовлення закриються завтра о 07:30.');
    expect(text).toContain(appUrl);
  });

  it('приватка — тільки дедлайн, без дати доставки і без назви групи', () => {
    const text = buildPrivateText({ closeLabel: 'завтра о 07:30', appUrl });
    expect(text).toContain('Закриються завтра о 07:30.');
    expect(text).not.toContain('Доставка');
    expect(text).not.toContain('13.08');
  });

  it('без налаштованого посилання повідомлення все одно самодостатнє', () => {
    const group = buildGroupText({
      groupName: 'Четвер', deliveryLabel: 'четвер, 13.08', closeLabel: 'завтра о 07:30', appUrl: '',
    });
    const priv = buildPrivateText({ closeLabel: 'завтра о 07:30', appUrl: '' });
    // Порожній URL не лишає по собі висячого рядка в кінці.
    expect(group.endsWith('зробіть замовлення.')).toBe(true);
    expect(priv.endsWith('зробіть замовлення.')).toBe(true);
  });

  it('фраза закриття збирається з now-відносного лейбла, а не з назви дня', () => {
    expect(closePhrase({ closeLabel: 'сьогодні', closeTime: '07:30' })).toBe('сьогодні о 07:30');
    expect(closePhrase({ closeLabel: 'в четвер', closeTime: '07:30' })).toBe('в четвер о 07:30');
  });

  describe('вікно вважається щойно відкритим', () => {
    const now = new Date('2026-08-08T12:00:00Z');
    const ago = (ms) => new Date(now.getTime() - ms);

    it('щойно відкрите — так', () => {
      expect(isFreshOpen(ago(0), now)).toBe(true);
      expect(isFreshOpen(ago(MAX_LATENESS_MS - 1), now)).toBe(true);
    });

    it('давно відкрите — ні: це вже не «старт замовлень»', () => {
      expect(isFreshOpen(ago(MAX_LATENESS_MS + 1), now)).toBe(false);
      expect(isFreshOpen(ago(9 * 3600 * 1000), now)).toBe(false);
    });

    it('момент відкриття В МАЙБУТНЬОМУ — ні', () => {
      // Регресія, спіймана наживо: опорою був OrderingSession.openAt, який
      // застаріває після зміни розкладу і показував відкриття «через 3.7 год».
      // Різниця виходила від'ємною, перевірка «не пізніше 2 годин» її пропускала,
      // і давно відкрите вікно розсилало повідомлення.
      expect(isFreshOpen(new Date(now.getTime() + 3.7 * 3600 * 1000), now)).toBe(false);
    });
  });

  it('дата доставки — це день закриття вікна, у форматі «<день тижня>, DD.MM»', () => {
    for (let day = 0; day <= 6; day += 1) {
      const label = deliveryDateLabel(day, SCHEDULE);
      expect(label.startsWith(`${DAY_FULL_UK[day]}, `)).toBe(true);
      expect(label).toMatch(/^[^,]+, \d{2}\.\d{2}$/);
    }
  });
});
