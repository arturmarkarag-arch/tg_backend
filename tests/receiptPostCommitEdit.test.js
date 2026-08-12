'use strict';

/**
 * Проведена накладна редагується далі (docs/receipt/readme.md §5). Тут
 * перевіряється те, заради чого це взагалі робилося: правка мусить дійти до
 * похідних документів, кількість — застосуватись РІЗНИЦЕЮ, а прибрати товар
 * можна лише поки ним ніхто не скористався.
 *
 * Потрібен replica set: rollback/propagate працюють у транзакціях.
 */

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const Block         = require('../models/Block');
const Order         = require('../models/Order');
const PickingTask   = require('../models/PickingTask');
const Product       = require('../models/Product');
const ProductVector = require('../models/ProductVector');
const ReceiptItem   = require('../models/ReceiptItem');
const ShopProduct   = require('../models/ShopProduct');

const {
  snapshotItem,
  describeItemUsage,
  propagateItemEdit,
  rollbackItemArtifacts,
} = require('../services/receiptSync');

let mongod;

const receiptId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(mongod.getUri());
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    Block.deleteMany({}),
    Order.deleteMany({}),
    PickingTask.deleteMany({}),
    Product.deleteMany({}),
    ProductVector.deleteMany({}),
    ReceiptItem.deleteMany({}),
    ShopProduct.deleteMany({}),
  ]);
});

/** Позиція «на склад», яка вже створила товар (тобто підтверджена й проведена). */
async function seedShelfItem({ totalQty = 10, price = 5, stockQty = totalQty } = {}) {
  const product = await Product.create({
    orderNumber: 1,
    price,
    quantity: stockQty,
    quantityPerPackage: 1,
    brand: 'Товар з накладної',
    status: 'pending',
    source: 'receipt',
    imageUrls: ['https://img.example/products/a.jpg'],
    imageNames: ['a.jpg'],
    originalImageUrl: 'https://img.example/originals/a.jpg',
  });
  const item = await ReceiptItem.create({
    receiptId,
    createdBy: '111',
    status: 'confirmed',
    destination: 'shelf',
    totalQty,
    price,
    qtyPerPackage: 1,
    photoUrl: 'https://img.example/products/a.jpg',
    photoName: 'a.jpg',
    originalPhotoUrl: 'https://img.example/originals/a.jpg',
    createdProductId: product._id,
    stockApplied: true,
  });
  await ShopProduct.create({
    linkedProductId: product._id,
    name: 'Товар з накладної',
    price,
    quantityPerPackage: 1,
    imageUrl: 'https://img.example/products/a.jpg',
    source: 'receive',
  });
  return { product, item };
}

describe('правка проведеної позиції протягується в товар і дзеркало', () => {
  it('кількість застосовується різницею, а не перезаписом', async () => {
    // Приїхало 10, склад потім вручну списав 3 → залишок 7.
    const { product, item } = await seedShelfItem({ totalQty: 10, stockQty: 7 });

    // Виявили, що насправді приїхало 12.
    const prev = snapshotItem(item);
    item.totalQty = 12;
    await item.save();
    const result = await propagateItemEdit(item, prev, {});

    const fresh = await Product.findById(product._id).lean();
    expect(fresh.quantity).toBe(9); // 7 + (12 - 10), а НЕ 12
    expect(result.quantityDelta).toBe(2);
    expect(result.quantityClamped).toBe(false);
  });

  it('від’ємний залишок обрізається нулем і позначається', async () => {
    const { product, item } = await seedShelfItem({ totalQty: 10, stockQty: 1 });

    const prev = snapshotItem(item);
    item.totalQty = 3; // -7 до залишку
    await item.save();
    const result = await propagateItemEdit(item, prev, {});

    const fresh = await Product.findById(product._id).lean();
    expect(fresh.quantity).toBe(0);
    expect(result.quantityClamped).toBe(true);
  });

  it('ціна доходить і до товару складу, і до дзеркала «Товари Магазинів»', async () => {
    const { product, item } = await seedShelfItem({ price: 5 });

    const prev = snapshotItem(item);
    item.price = 8.5;
    await item.save();
    await propagateItemEdit(item, prev, {});

    const freshProduct = await Product.findById(product._id).lean();
    const mirror = await ShopProduct.findOne({ linkedProductId: product._id }).lean();
    expect(freshProduct.price).toBe(8.5);
    expect(mirror.price).toBe(8.5);
  });

  it('перемальовані підписи не тягнуть перегенерацію вектора, підміна світлини — тягне', async () => {
    const { item } = await seedShelfItem();

    // Правка ціни: новий анотований файл, чистий оригінал той самий.
    let prev = snapshotItem(item);
    item.photoUrl = 'https://img.example/products/a-v2.jpg';
    item.photoName = 'a-v2.jpg';
    await item.save();
    expect((await propagateItemEdit(item, prev, {})).reembed).toBeNull();

    // Перезняли товар: інший оригінал → вектор застарів.
    prev = snapshotItem(item);
    item.originalPhotoUrl = 'https://img.example/originals/b.jpg';
    await item.save();
    expect((await propagateItemEdit(item, prev, {})).reembed).toBe('warehouse');
  });

  it('замовлення магазинів правка не чіпає — ціна в них зафіксована', async () => {
    const { product, item } = await seedShelfItem({ price: 5 });
    const order = await Order.create({
      orderNumber: 900,
      buyerTelegramId: '222',
      status: 'new',
      items: [{ productId: product._id, name: 'Товар', price: 5, quantity: 2 }],
      totalPrice: 10,
    });

    const prev = snapshotItem(item);
    item.price = 9;
    await item.save();
    await propagateItemEdit(item, prev, {});

    const freshOrder = await Order.findById(order._id).lean();
    expect(freshOrder.items[0].price).toBe(5);
    expect(freshOrder.items[0].cancelled).toBeFalsy();
    expect(freshOrder.totalPrice).toBe(10);
  });
});

describe('прибрати позицію можна лише поки товар нікуди не поїхав', () => {
  it('чистий товар: перешкод немає', async () => {
    const { item } = await seedShelfItem();
    expect((await describeItemUsage(item, {})).inUse).toBe(false);
  });

  it('товар у блоці, в замовленні або в збиранні — перешкода з причиною', async () => {
    const { product, item } = await seedShelfItem();
    await Block.create({ blockId: 12, productIds: [product._id] });
    await Order.create({
      orderNumber: 901,
      buyerTelegramId: '222',
      status: 'new',
      items: [{ productId: product._id, name: 'Товар', price: 5, quantity: 1 }],
      totalPrice: 5,
    });
    await PickingTask.create({
      productId: product._id,
      deliveryGroupId: 'g1',
      blockId: 12,
      positionIndex: 1,
      status: 'pending',
    });

    const usage = await describeItemUsage(item, {});
    expect(usage.inUse).toBe(true);
    expect(usage.reasons.join(' ')).toContain('блоці 12');
    expect(usage.reasons.join(' ')).toContain('замовленнях');
    expect(usage.reasons.join(' ')).toContain('збирання');
  });

  // Живі шляхи (DELETE позиції / зняття підтвердження) виконують перевірку і
  // відкат ВСЕРЕДИНІ транзакції — саме там, де не всі операції Mongo дозволені.
  it('перевірка і відкат працюють усередині транзакції', async () => {
    const { product, item } = await seedShelfItem();
    await ProductVector.create({ productId: product._id, geminiVector: [0.3] });

    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const live = await ReceiptItem.findById(item._id).session(session);
        const usage = await describeItemUsage(live, { session });
        expect(usage.inUse).toBe(false);
        await rollbackItemArtifacts(live, { session });
        await live.save({ session });
        await live.deleteOne({ session });
      });
    } finally {
      session.endSession();
    }

    expect(await ReceiptItem.countDocuments({})).toBe(0);
    expect(await Product.countDocuments({})).toBe(0);
    expect(await ShopProduct.countDocuments({})).toBe(0);
    expect(await ProductVector.countDocuments({})).toBe(0);
  });

  it('відкат прибирає товар, дзеркало і вектор', async () => {
    const { product, item } = await seedShelfItem();
    await ProductVector.create({ productId: product._id, geminiVector: [0.1, 0.2] });

    const removed = await rollbackItemArtifacts(item, {});
    await item.save();

    expect(removed.productId).toBe(String(product._id));
    expect(await Product.countDocuments({})).toBe(0);
    expect(await ShopProduct.countDocuments({})).toBe(0);
    expect(await ProductVector.countDocuments({})).toBe(0);

    const freshItem = await ReceiptItem.findById(item._id).lean();
    expect(freshItem.createdProductId).toBeNull();
    expect(freshItem.stockApplied).toBe(false);
  });
});
