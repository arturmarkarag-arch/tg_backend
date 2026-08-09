'use strict';

/**
 * restoreSkippedOrder — воскресіння замовлення, вбитого strict late-reconcile.
 *
 * Знімає `skipped` з позицій, перераховує суму, повертає активний статус і —
 * найголовніше — переносить замовлення в сесію, де його реально зберуть. Без
 * останнього кроку воскресіння безглузде: найближчий прохід
 * services/lateOrderReconcile.js убив би позиції знову.
 *
 * Вибір цільової сесії повторює виправлену логіку services/migrateSellerShop.js:
 *   поточна сесія групи `pending`      → туди (зберуть цього ж циклу);
 *   поточна вже confirmed/in_progress/completed → НАСТУПНА сесія (openDate + 7).
 *
 * DRY-RUN за замовчуванням — друкує план і виходить. Пише лише з --execute.
 *
 *   node scripts/restoreSkippedOrder.js --order=3
 *   node scripts/restoreSkippedOrder.js --order=3 --execute
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');

// Моделі нижче потрібні заради спільної з сервером логіки сесій. autoIndex вимкнено
// ДО їх завантаження: інакше mongoose спробує створити індекси на живій базі як
// побічний ефект імпорту — у dry-run це був би запис.
mongoose.set('autoIndex', false);

const Order = require('../models/Order');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const { getOpenDateWarsaw } = require('../utils/orderingSchedule');
const { getOrCreateSessionId, getOrCreateNextSessionId } = require('../utils/getOrCreateSession');
const { roundMoney } = require('../utils/money');

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const EXECUTE = argv.includes('--execute');
// Дозвіл закрити ПОРОЖНЄ замовлення, що тримає слот унікального індексу в
// цільовій сесії. Окремий прапорець, бо це запис у ДРУГЕ замовлення.
const CLOSE_CONFLICT = argv.includes('--close-conflict');
const ORDER_NUMBER = arg('order') ? Number(arg('order')) : null;
const ORDER_ID = arg('id');

const dtf = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const T = (d) => (d ? dtf.format(new Date(d)) : '—');

/** "YYYY-MM-DD" + N днів, чистою календарною арифметикою (як getOrCreateSession). */
function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

async function main() {
  if (!ORDER_NUMBER && !ORDER_ID) throw new Error('Вкажіть --order=<номер> або --id=<ObjectId>');
  await mongoose.connect(process.env.MONGODB_URI);

  console.log(`\n${EXECUTE ? '🔴 EXECUTE — запис у базу' : '🟡 DRY-RUN — жодного запису'}`);
  console.log(`   база: ${mongoose.connection.db.databaseName}   host: ${mongoose.connection.host}\n`);

  const order = ORDER_ID
    ? await Order.findById(ORDER_ID)
    : await Order.findOne({ orderNumber: ORDER_NUMBER });
  if (!order) throw new Error('Замовлення не знайдено');

  const skippedItems = (order.items || []).filter((i) => i.skipped);
  console.log(`ЗАМОВЛЕННЯ #${order.orderNumber}  _id=${order._id}`);
  console.log(`  статус: ${order.status}   сума: ${order.totalPrice}   позицій: ${order.items.length} (skipped: ${skippedItems.length})`);
  console.log(`  магазин: ${order.buyerSnapshot?.shopName || '—'}   продавець tg: ${order.buyerTelegramId}`);
  console.log(`  сесія зараз: ${order.orderingSessionId}`);

  if (!skippedItems.length) {
    console.log('\n✅ Skipped-позицій немає — відновлювати нічого.');
    return;
  }

  const groupId = String(order.buyerSnapshot?.deliveryGroupId || '');
  const group = groupId ? await DeliveryGroup.findById(groupId).lean() : null;
  if (!group) throw new Error(`Групу доставки ${groupId} не знайдено — сесію не обчислити`);

  const schedule = group.orderingSchedule;
  const currentOpenDate = getOpenDateWarsaw(group.orderingSchedule);
  const nextOpenDate = addDays(currentOpenDate, 7);

  const currentSession = await OrderingSession.findOne({ groupId, openDate: currentOpenDate }).lean();
  const nextSession = await OrderingSession.findOne({ groupId, openDate: nextOpenDate }).lean();

  console.log(`\n  ГРУПА: ${group.name} (dayOfWeek=${group.dayOfWeek})`);
  console.log(`    поточна сесія  ${currentOpenDate}: ${currentSession ? `pickingStatus=${currentSession.pickingStatus} _id=${currentSession._id}` : 'ще не створена (буде pending)'}`);
  console.log(`    наступна сесія ${nextOpenDate}: ${nextSession ? `pickingStatus=${nextSession.pickingStatus} _id=${nextSession._id}` : 'ще не створена'}`);

  // Та сама умова, що й у виправленому migrateSellerShop: рішення береться зі
  // стану сесії, а не з наявності задач.
  const currentInPicking = !!currentSession && currentSession.pickingStatus !== 'pending';
  const targetOpenDate = currentInPicking ? nextOpenDate : currentOpenDate;
  const targetExisting = currentInPicking ? nextSession : currentSession;

  console.log(`\n  ЦІЛЬОВА СЕСІЯ: ${targetOpenDate} ${currentInPicking
    ? '(поточна вже в збиранні → паркуємо в наступну)'
    : '(поточна ще pending → зберуть цього циклу)'}`);

  // Унікальний індекс one_active_order_per_buyer_shop_session: якщо у продавця вже
  // є активне замовлення в цільовій сесії, збереження впаде E11000. Ловимо заздалегідь.
  let clash = null;
  if (targetExisting) {
    clash = await Order.findOne({
      buyerTelegramId: order.buyerTelegramId,
      shopId: order.shopId,
      orderingSessionId: String(targetExisting._id),
      status: { $in: ['new', 'in_progress'] },
      _id: { $ne: order._id },
    }).lean();
  }

  if (clash) {
    // Жива позиція = не cancelled і не skipped (те саме визначення, що в
    // closeOrderIfNoLiveItems у routes/orders.js). Замовлення з живими позиціями
    // не чіпаємо НІКОЛИ — воно справжнє, і рішення про нього не за скриптом.
    const clashLive = (clash.items || []).filter((i) => !i.cancelled && !i.skipped);
    console.log(`\n  КОНФЛІКТ: у цільовій сесії вже стоїть активне замовлення #${clash.orderNumber} (_id=${clash._id})`);
    console.log(`    статус: ${clash.status}   позицій: ${(clash.items || []).length}   з них живих: ${clashLive.length}`);

    if (clashLive.length > 0) {
      console.log('\n❌ У ньому є ЖИВІ позиції — скрипт його не чіпає. Вирішіть вручну, яке з двох лишається.');
      return;
    }
    if (!CLOSE_CONFLICT) {
      console.log('\n❌ Воно порожнє (жодної живої позиції), але слот тримає.');
      console.log('   Щоб закрити його як `cancelled` і звільнити слот, додайте --close-conflict');
      return;
    }
    console.log('    → буде закрите як `cancelled` (auto_closed_empty), слот звільниться');
  }

  const newTotal = roundMoney((order.items || [])
    .filter((i) => !i.cancelled)
    .reduce((s, i) => s + Number(i.price || 0) * Number(i.quantity || 0), 0));

  console.log('\n  ПЛАН ЗМІН:');
  for (const it of skippedItems) {
    console.log(`    • "${it.name}" ×${it.quantity} — skipped: true → false   (ціна ${it.price} zł${!it.price ? ' ⚠️ нульова' : ''})`);
  }
  console.log(`    • status: ${order.status} → new`);
  console.log(`    • totalPrice: ${order.totalPrice} → ${newTotal}`);
  console.log(`    • orderingSessionId: ${order.orderingSessionId} → сесія ${targetOpenDate}${targetExisting ? ` (${targetExisting._id})` : ' (буде створена)'}`);
  console.log('    • history += order_restored');

  if (!EXECUTE) {
    console.log('\n🟡 DRY-RUN завершено. Для запису додайте --execute\n');
    return;
  }

  // Створюємо цільову сесію тільки тепер — у dry-run це був би побічний запис.
  const targetSessionId = currentInPicking
    ? await getOrCreateNextSessionId(groupId, schedule)
    : await getOrCreateSessionId(groupId, schedule);
  if (!targetSessionId) throw new Error('Не вдалося отримати цільову сесію (maintenance-режим?)');

  const mongoSession = await mongoose.connection.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      // Слот звільняємо в ТІЙ САМІЙ транзакції: інакше між закриттям порожнього
      // і збереженням відновленого лишається вікно, у яке може влізти новий запис.
      if (clash) {
        const clashFresh = await Order.findById(clash._id).session(mongoSession);
        if (!clashFresh) throw new Error('Конфліктне замовлення зникло між читанням і записом');
        const stillLive = (clashFresh.items || []).filter((i) => !i.cancelled && !i.skipped);
        if (stillLive.length > 0) throw new Error(`У #${clashFresh.orderNumber} з'явилися живі позиції — перервано`);
        clashFresh.status = 'cancelled';
        clashFresh.history.push({
          at: new Date(),
          by: 'system',
          byName: 'restoreSkippedOrder',
          byRole: 'system',
          action: 'auto_closed_empty',
          meta: { reason: 'no_live_items', freedSlotFor: String(order._id) },
        });
        await clashFresh.save({ session: mongoSession });
        console.log(`\n✅ #${clashFresh.orderNumber} закрито як cancelled — слот вільний`);
      }

      const fresh = await Order.findById(order._id).session(mongoSession);
      if (!fresh) throw new Error('Замовлення зникло між читанням і записом');

      let revived = 0;
      for (const item of fresh.items) {
        if (!item.skipped) continue;
        item.skipped = false;
        revived += 1;
      }

      fresh.totalPrice = roundMoney(fresh.items
        .filter((i) => !i.cancelled)
        .reduce((s, i) => s + Number(i.price || 0) * Number(i.quantity || 0), 0));
      fresh.status = 'new';
      fresh.orderingSessionId = String(targetSessionId);
      fresh.history.push({
        at: new Date(),
        by: 'system',
        byName: 'restoreSkippedOrder',
        byRole: 'system',
        action: 'order_restored',
        meta: {
          revived,
          fromSessionId: String(order.orderingSessionId || ''),
          toSessionId: String(targetSessionId),
          toOpenDate: targetOpenDate,
          reason: 'late_skip_caused_by_shop_reassign_into_completed_session',
        },
      });

      await fresh.save({ session: mongoSession });
      console.log(`\n✅ Відновлено позицій: ${revived}`);
    });
  } finally {
    await mongoSession.endSession();
  }

  const after = await Order.findById(order._id).lean();
  console.log('\n  ПІСЛЯ ЗАПИСУ:');
  console.log(`    статус: ${after.status}   сума: ${after.totalPrice}   сесія: ${after.orderingSessionId}`);
  console.log(`    позицій skipped: ${(after.items || []).filter((i) => i.skipped).length}`);
  console.log(`    остання подія історії: ${T(after.history[after.history.length - 1]?.at)} ${after.history[after.history.length - 1]?.action}`);
  console.log('\n⚠️  PickingTask НЕ створюються цим скриптом — план збору будує start-session,');
  console.log('    коли склад відкриє сторінку збору вже після закриття вікна.\n');
}

main()
  .catch((err) => { console.error('\n❌', err.message, '\n', err.stack); process.exitCode = 1; })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
    // Без явного quit() відкриті сокети тримають event loop і скрипт висить
    // назавжди вже ПІСЛЯ того, як усе зробив.
    try {
      const { redis, pubClient, subClient } = require('../utils/redis');
      await Promise.all([redis, pubClient, subClient].filter(Boolean).map((c) => c.quit().catch(() => {})));
    } catch { /* Redis не налаштований — нічого закривати */ }
  });
