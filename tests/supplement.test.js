'use strict';

/**
 * Інваріанти дозамовлень, які НЕ можна перевірити оком у браузері, бо вони про
 * час і про те, чиє рішення головніше. Сценарії — з розділу §22 специфікації.
 */

const {
  effectiveOfferStatus,
  isOfferOpenForSellers,
  offerViewForWarehouse,
  formatLocation,
} = require('../services/supplementOffers');
const { dueAtFor, LONG_WINDOW_MINUTES } = require('../services/supplementNotify');

const MIN = 60 * 1000;

function offerAt({ status = 'open', minutesFromNow = 10, now = Date.now() }) {
  return { status, closesAt: new Date(now + minutesFromNow * MIN) };
}

describe('effectiveOfferStatus — дедлайн вирішує сервер, а не планувальник (§21, тест 8)', () => {
  const now = new Date('2026-08-05T07:50:00Z');

  it('відкрита пропозиція до дедлайну лишається open', () => {
    const offer = { status: 'open', closesAt: new Date(now.getTime() + 5 * MIN) };
    expect(effectiveOfferStatus(offer, now)).toBe('open');
    expect(isOfferOpenForSellers(offer, now)).toBe(true);
  });

  // Головне: у базі ще 'open' (планувальник тікає раз на 15 с), але час минув.
  // Якби перевірки читали сирий status, у цьому вікні продавець ще міг би
  // змінити заявку, а склад уже бачив би активну кнопку «Спакував».
  it('після closesAt пропозиція вважається frozen, навіть якщо в базі ще open', () => {
    const offer = { status: 'open', closesAt: new Date(now.getTime() - 1000) };
    expect(effectiveOfferStatus(offer, now)).toBe('frozen');
    expect(isOfferOpenForSellers(offer, now)).toBe(false);
  });

  it('рівно на межі closesAt вікно вже закрите', () => {
    const offer = { status: 'open', closesAt: new Date(now.getTime()) };
    expect(effectiveOfferStatus(offer, now)).toBe('frozen');
  });

  it('completed не «розморожується» майбутнім дедлайном', () => {
    const offer = { status: 'completed', closesAt: new Date(now.getTime() + 60 * MIN) };
    expect(effectiveOfferStatus(offer, now)).toBe('completed');
    expect(isOfferOpenForSellers(offer, now)).toBe(false);
  });
});

describe('canComplete — «Спакував» вирішує сервер (§21, тести 6 і 9)', () => {
  const now = new Date('2026-08-05T08:20:00Z');
  const product = { _id: 'p1', brand: 'Товар', orderNumber: 1, imageUrls: [] };

  const build = (offer, requests) => offerViewForWarehouse(offer, {
    product,
    requests,
    location: null,
    boxNumberFor: () => null,
    now,
  });

  // Тест 6: склад може пакувати ще до заморозки, але завершити — ні. До дедлайну
  // може додатися ще один магазин, і завершена пропозиція його б не побачила.
  it('усі спаковані, але вікно ще відкрите → завершити не можна', () => {
    const view = build(offerAt({ minutesFromNow: 5, now: now.getTime() }), [
      { _id: 'r1', shopId: 's1', shopName: 'А', quantity: 2, packed: true },
    ]);
    expect(view.status).toBe('open');
    expect(view.canComplete).toBe(false);
  });

  // Тест 9: після заморозки, але не всі магазини відмічені.
  it('заморожено, спаковані не всі → завершити не можна', () => {
    const view = build({ status: 'frozen', closesAt: new Date(now.getTime() - MIN) }, [
      { _id: 'r1', shopId: 's1', shopName: 'А', quantity: 2, packed: true },
      { _id: 'r2', shopId: 's2', shopName: 'Б', quantity: 1, packed: false },
    ]);
    expect(view.canComplete).toBe(false);
    expect(view.packedCount).toBe(1);
  });

  it('заморожено і всі спаковані → завершити можна', () => {
    const view = build({ status: 'frozen', closesAt: new Date(now.getTime() - MIN) }, [
      { _id: 'r1', shopId: 's1', shopName: 'А', quantity: 2, packed: true },
      { _id: 'r2', shopId: 's2', shopName: 'Б', quantity: 1, packed: true },
    ]);
    expect(view.canComplete).toBe(true);
    expect(view.totalQty).toBe(3);
  });

  // Тест 10: пропозицію без жодної заявки завершує планувальник, а не людина —
  // складу нема чого пакувати, тож кнопка мусить лишатись неактивною.
  it('заморожено без заявок → кнопки немає (закриє планувальник)', () => {
    const view = build({ status: 'frozen', closesAt: new Date(now.getTime() - MIN) }, []);
    expect(view.canComplete).toBe(false);
    expect(view.shops).toHaveLength(0);
  });

  it('магазини сортуються за номером коробки, безномерні — у хвіст', () => {
    const view = offerViewForWarehouse(offerAt({ minutesFromNow: 5, now: now.getTime() }), {
      product,
      requests: [
        { _id: 'r1', shopId: 's1', shopName: 'Вега', quantity: 1, packed: false },
        { _id: 'r2', shopId: 's2', shopName: 'Альфа', quantity: 1, packed: false },
        { _id: 'r3', shopId: 's3', shopName: 'Бета', quantity: 1, packed: false },
      ],
      location: { blockId: 4, positionIndex: 2 },
      boxNumberFor: (r) => ({ s1: 7, s2: 3 })[String(r.shopId)] ?? null,
      now,
    });
    expect(view.shops.map((s) => s.shopName)).toEqual(['Альфа', 'Вега', 'Бета']);
    expect(view.location.label).toBe('Блок 4, позиція 2');
  });
});

describe('formatLocation — фізичне місце товару (§9)', () => {
  it('без блока товар лежить у Надходженнях', () => {
    expect(formatLocation(null)).toBe('Надходження');
  });
  it('у блоці показує блок і позицію', () => {
    expect(formatLocation({ blockId: 12, positionIndex: 5 })).toBe('Блок 12, позиція 5');
  });
});

describe('dueAtFor — адаптивний графік нагадувань (§15)', () => {
  const opened = new Date('2026-08-05T07:40:00Z');
  const mk = (minutes) => ({
    openedAt: opened,
    closesAt: new Date(opened.getTime() + minutes * MIN),
  });

  it('коротке вікно (≤30 хв): без «посередині», попередження за 5 хв', () => {
    const offer = mk(30);
    expect(dueAtFor(offer, 'mid')).toBeNull();
    expect(dueAtFor(offer, 'soon')).toEqual(new Date(offer.closesAt.getTime() - 5 * MIN));
  });

  it('довге вікно (>30 хв): «посередині» + попередження за 10 хв', () => {
    const offer = mk(60);
    expect(dueAtFor(offer, 'mid')).toEqual(new Date(opened.getTime() + 30 * MIN));
    expect(dueAtFor(offer, 'soon')).toEqual(new Date(offer.closesAt.getTime() - 10 * MIN));
  });

  it('стартове повідомлення йде в момент відкриття', () => {
    expect(dueAtFor(mk(30), 'opened')).toEqual(opened);
  });

  // Вікно 3 хв: «за 5 хв до закриття» припало б на час ДО відкриття — тобто
  // друге повідомлення злилося б зі стартовим. Тоді його просто немає.
  it('вікно коротше за випередження → нагадування не планується', () => {
    expect(dueAtFor(mk(3), 'soon')).toBeNull();
    expect(dueAtFor(mk(5), 'soon')).toBeNull();
  });

  it('межа «довгого» вікна не зсунулась', () => {
    expect(LONG_WINDOW_MINUTES).toBe(30);
    expect(dueAtFor(mk(LONG_WINDOW_MINUTES), 'mid')).toBeNull();
    expect(dueAtFor(mk(LONG_WINDOW_MINUTES + 1), 'mid')).not.toBeNull();
  });
});
