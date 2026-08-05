'use strict';

const {
  effectiveOfferStatus,
  isOfferOpenForSellers,
  offerViewForWarehouse,
  formatLocation,
} = require('../services/supplementOffers');
const { buildText, REMINDER_EVERY_MS } = require('../services/supplementNotify');

describe('ручний життєвий цикл дозамовлення', () => {
  it('open лишається open незалежно від старого closesAt', () => {
    const offer = { status: 'open', closesAt: new Date('2020-01-01T00:00:00Z') };
    expect(effectiveOfferStatus(offer)).toBe('open');
    expect(isOfferOpenForSellers(offer)).toBe(true);
  });

  it('frozen блокує продавця', () => {
    const offer = { status: 'frozen' };
    expect(effectiveOfferStatus(offer)).toBe('frozen');
    expect(isOfferOpenForSellers(offer)).toBe(false);
  });

  it('completed не приймає заявки', () => {
    expect(isOfferOpenForSellers({ status: 'completed' })).toBe(false);
  });
});

describe('canComplete — завершення тільки після ручного frozen', () => {
  const product = { _id: 'p1', brand: 'Товар', orderNumber: 1, imageUrls: [] };
  const build = (offer, requests) => offerViewForWarehouse(offer, {
    product,
    requests,
    location: null,
    boxNumberFor: () => null,
  });

  it('усі спаковані, але статус open → завершити не можна', () => {
    const view = build({ status: 'open' }, [
      { _id: 'r1', shopId: 's1', shopName: 'А', quantity: 2, packed: true },
    ]);
    expect(view.canComplete).toBe(false);
  });

  it('frozen, але спаковані не всі → завершити не можна', () => {
    const view = build({ status: 'frozen' }, [
      { _id: 'r1', shopId: 's1', shopName: 'А', quantity: 2, packed: true },
      { _id: 'r2', shopId: 's2', shopName: 'Б', quantity: 1, packed: false },
    ]);
    expect(view.canComplete).toBe(false);
  });

  it('frozen і всі спаковані → завершити можна', () => {
    const view = build({ status: 'frozen' }, [
      { _id: 'r1', shopId: 's1', shopName: 'А', quantity: 2, packed: true },
      { _id: 'r2', shopId: 's2', shopName: 'Б', quantity: 1, packed: true },
    ]);
    expect(view.canComplete).toBe(true);
    expect(view.totalQty).toBe(3);
  });

  it('frozen без заявок → завершити кнопкою не можна', () => {
    const view = build({ status: 'frozen' }, []);
    expect(view.canComplete).toBe(false);
  });
});

describe('номер коробки та місце товару', () => {
  const product = { _id: 'p1', brand: 'Товар', orderNumber: 1, imageUrls: [] };

  it('номер коробки не вигадується', () => {
    const view = offerViewForWarehouse({ status: 'frozen' }, {
      product,
      requests: [
        { _id: 'r1', shopId: 's1', shopName: 'Альфа', quantity: 1, packed: false },
        { _id: 'r2', shopId: 's2', shopName: 'Бета', quantity: 1, packed: false },
      ],
      location: null,
      boxNumberFor: (request) => (String(request.shopId) === 's1' ? 4 : null),
    });
    expect(view.shops.find((shop) => shop.shopName === 'Альфа').shopNumber).toBe(4);
    expect(view.shops.find((shop) => shop.shopName === 'Бета').shopNumber).toBeNull();
  });

  it('форматує фізичне місце', () => {
    expect(formatLocation(null)).toBe('Надходження');
    expect(formatLocation({ blockId: 12, positionIndex: 5 })).toBe('Блок 12, позиція 5');
  });
});

describe('Telegram-тексти', () => {
  const appUrl = 'https://t.me/ZLOTOWECZKA_chat_bot/app';

  it('стартове повідомлення не містить товарів, ціни або часу', () => {
    const text = buildText('opened', { groupName: 'Четвер Тест', appUrl });
    expect(text).toContain('‼️');
    expect(text).toContain('Дозамовлення — Четвер Тест');
    expect(text).toContain('ЗРОБІТЬ ТЕРМІНОВО ЗАМОВЛЕННЯ');
    expect(text).toContain(appUrl);
    expect(text).not.toContain('хв');
    expect(text).not.toContain('zł');
  });

  it('нагадування має окремий заголовок і йде кожні 2 години', () => {
    const text = buildText('reminder', { groupName: 'Четвер Тест', appUrl });
    expect(text).toContain('Нагадування — Дозамовлення — Четвер Тест');
    expect(REMINDER_EVERY_MS).toBe(2 * 60 * 60 * 1000);
  });
});

describe('індекси повторних накладних-дозамовлень', () => {
  it('не забороняє одночасні пропозиції того самого товару в одній групі з різних накладних', () => {
    const SupplementOffer = require('../models/SupplementOffer');
    const indexes = SupplementOffer.schema.indexes();

    const hasReceiptItemUnique = indexes.some(([keys, options]) => (
      keys.receiptItemId === 1
      && keys.deliveryGroupId === 1
      && options.unique === true
    ));
    expect(hasReceiptItemUnique).toBe(true);

    const hasProductGroupUnique = indexes.some(([keys, options]) => (
      keys.productId === 1
      && keys.deliveryGroupId === 1
      && options.unique === true
    ));
    expect(hasProductGroupUnique).toBe(false);
  });
});
