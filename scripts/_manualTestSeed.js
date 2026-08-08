'use strict';
/**
 * ТИМЧАСОВИЙ seed для ручної перевірки picking у міні-апі. ТІЛЬКИ тестова база.
 *
 * Створює замовлення в групі "Доставка Понеділок" від різних продавців, у
 * поточній ordering-сесії. Вікно замовлень уже закрите → складник одразу може
 * тиснути "Розпочати збирання".
 *
 *   node -r ../dev-use-test-db.js scripts/_manualTestSeed.js
 *   node -r ../dev-use-test-db.js scripts/_manualTestSeed.js --cleanup
 */
const mongoose = require('mongoose');
const Order = require('../models/Order');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');

const MARK = '__MANUAL_TEST__';

// Той самий кластерний запобіжник, що й у live-E2E: скрипт пише дані.
if (!String(process.env.MONGODB_URI || '').includes('epfky0s.mongodb.net')) {
  console.error('⛔ Не тестовий кластер. Запускай через: node -r ../dev-use-test-db.js scripts/_manualTestSeed.js');
  process.exit(3);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log('host:', mongoose.connection.host);

  const group = await db.collection('deliverygroups').findOne({ name: /Понеділок/ });
  if (!group) throw new Error('групу "Доставка Понеділок" не знайдено');

  if (process.argv.includes('--cleanup')) {
    const orders = await Order.deleteMany({ 'history.meta.mark': MARK });
    const tasks = await db.collection('pickingtasks').deleteMany({ deliveryGroupId: String(group._id) });
    await db.collection('orderingsessions').updateOne(
      { _id: new mongoose.Types.ObjectId(await getOrCreateSessionId(String(group._id), group.dayOfWeek, await getOrderingSchedule())) },
      { $set: { pickingStatus: 'pending' }, $unset: { pickingConfirmedAt: '', pickingStartedAt: '', pickingCompletedAt: '' } },
    );
    console.log('видалено замовлень:', orders.deletedCount, '| задач:', tasks.deletedCount, '| сесію повернуто в pending');
    await mongoose.disconnect();
    return;
  }

  const schedule = await getOrderingSchedule();
  const sessionId = await getOrCreateSessionId(String(group._id), group.dayOfWeek, schedule);
  console.log('group:', group.name, '| session:', sessionId);

  // Тільки товари, що фізично лежать у блоках — інакше taskBuilder їх пропустить
  // і ми отримаємо coverage_gap замість робочої черги.
  const blocks = await db.collection('blocks')
    .find({ 'productIds.0': { $exists: true } }).sort({ blockId: 1 }).limit(4).toArray();
  const pidPool = blocks.flatMap((b) => b.productIds);
  const products = await db.collection('products')
    .find({ _id: { $in: pidPool }, status: 'active' }).limit(9).toArray();
  if (products.length < 3) throw new Error('замало активних товарів у блоках');

  const shops = await db.collection('shops')
    .find({ deliveryGroupId: String(group._id), isActive: true }).toArray();
  const shopById = new Map(shops.map((s) => [String(s._id), s]));
  const sellers = await db.collection('users')
    .find({ role: 'seller', shopId: { $in: shops.map((s) => s._id) } }).limit(3).toArray();
  if (!sellers.length) throw new Error('немає продавців у групі');

  const cities = await db.collection('cities').find({}).toArray();
  const cityName = (id) => cities.find((c) => String(c._id) === String(id))?.name || '';

  const last = await Order.findOne({}).sort({ orderNumber: -1 }).select('orderNumber').lean();
  let nextNumber = (last?.orderNumber || 0) + 1;

  let n = 0;
  for (let i = 0; i < sellers.length; i += 1) {
    const seller = sellers[i];
    const shop = shopById.get(String(seller.shopId));
    if (!shop) continue;
    // Перекриваємо товари між продавцями: так одна PickingTask міститиме
    // кілька магазинів — саме той екран, де живуть галочки і flushSave.
    const picked = [products[0], products[1], products[2 + i]].filter(Boolean);

    const items = picked.map((p) => ({
      productId: p._id,
      name: p.brand || p.model || p.category || `#${p.orderNumber}`,
      price: p.price || 0,
      quantity: 1 + (i % 3),
      packed: false, cancelled: false, skipped: false,
    }));

    const order = await Order.create({
      buyerTelegramId: String(seller.telegramId),
      shopId: shop._id,
      items,
      status: 'new',
      totalPrice: items.reduce((s, it) => s + it.price * it.quantity, 0),
      orderingSessionId: sessionId,
      orderNumber: nextNumber++,
      buyerSnapshot: {
        shopId: shop._id,
        shopName: shop.name || '',
        shopCity: cityName(shop.cityId),
        shopAddress: shop.address || '',
        deliveryGroupId: String(group._id),
      },
      history: [{
        at: new Date(), by: 'system', byName: 'manual-test-seed', byRole: 'system',
        action: 'created', meta: { mark: MARK },
      }],
    });
    n += 1;
    console.log(`  #${order.orderNumber} — ${shop.name} · ${[seller.firstName, seller.lastName].filter(Boolean).join(' ')} — позицій: ${items.length}`);
  }

  console.log(`\n✅ створено замовлень: ${n} | група: ${group.name}`);
  console.log('Прибрати: node -r ../dev-use-test-db.js scripts/_manualTestSeed.js --cleanup');
  await mongoose.disconnect();
}

main().catch((e) => { console.error('ERR:', e.message); process.exitCode = 1; });
