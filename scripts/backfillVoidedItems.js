'use strict';

/**
 * backfillVoidedItems — terminalises still-open items inside historical
 * status='expired' Orders.
 *
 * DRY-RUN by default:
 *   node scripts/backfillVoidedItems.js
 *   node scripts/backfillVoidedItems.js --execute
 *
 * No Mongoose models are imported, so this script cannot trigger model autoIndex.
 * It writes ONLY to `orders` and ONLY to currently non-terminal rows of Orders
 * that are already status='expired'. Packed/cancelled/skipped/voided rows are
 * never touched.
 */

const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const EXECUTE = process.argv.includes('--execute');
const NOW = new Date();

const dtf = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const T = (d) => (d ? dtf.format(new Date(d)) : '—');
const isOpen = (i) => !i?.packed && !i?.cancelled && !i?.skipped && !i?.voided;

function inferredVoidAt(order) {
  // For legacy rows we cannot reconstruct the exact millisecond the status was
  // changed, but updatedAt is the best persisted approximation and is strictly
  // better forensic data than stamping the migration run time on old history.
  const candidate = order?.updatedAt || order?.createdAt || NOW;
  const dt = new Date(candidate);
  return Number.isNaN(dt.getTime()) ? NOW : dt;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI не заданий у .env');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20_000 });
  const db = mongoose.connection.db;
  const orders = db.collection('orders');

  console.log(`\n🔁 backfillVoidedItems — режим: ${EXECUTE ? '⚠️  ЗАПИС (--execute)' : 'DRY-RUN (нічого не пишу)'}`);
  console.log(`   база: ${db.databaseName}   host: ${mongoose.connection.host}\n`);

  const affected = await orders.find({
    status: 'expired',
    items: {
      $elemMatch: {
        packed: { $ne: true },
        cancelled: { $ne: true },
        skipped: { $ne: true },
        voided: { $ne: true },
      },
    },
  }).sort({ createdAt: 1, _id: 1 }).toArray();

  if (!affected.length) {
    console.log('✅ Expired-замовлень із незакритими позиціями немає. Робити нічого.\n');
    return;
  }

  let totalRows = 0;
  console.log(`📦 Замовлень під бекфіл: ${affected.length}\n`);
  for (const order of affected) {
    const open = (order.items || []).filter(isOpen);
    totalRows += open.length;
    const lastAction = (order.history || []).slice(-1)[0]?.action || '—';
    console.log(`  #${order.orderNumber ?? '—'}  _id=${order._id}  ${order.buyerSnapshot?.shopName || '—'}`);
    console.log(`     створено ${T(order.createdAt)}   updatedAt ${T(order.updatedAt)}   остання дія: ${lastAction}`);
    console.log(`     позицій усього ${(order.items || []).length}, з них погасимо ${open.length}:`);
    for (const item of open) {
      console.log(`       • "${item.name || '—'}" ×${item.quantity}  productId=${item.productId}`);
    }
    console.log('');
  }

  console.log(`РАЗОМ: ${affected.length} замовлень, ${totalRows} позицій отримають:`);
  console.log('       voided=true, voidReason="order_expired", voidedAt≈Order.updatedAt');
  console.log('       packed/cancelled/skipped/quantity/price НЕ змінюються.\n');

  if (!EXECUTE) {
    console.log('DRY-RUN — у базу нічого не записано.');
    console.log('Для застосування: node scripts/backfillVoidedItems.js --execute\n');
    return;
  }

  const operations = affected.map((order) => ({
    updateOne: {
      filter: { _id: order._id, status: 'expired' },
      update: {
        $set: {
          'items.$[open].voided': true,
          'items.$[open].voidReason': 'order_expired',
          'items.$[open].voidedAt': inferredVoidAt(order),
        },
      },
      arrayFilters: [{
        'open.packed': { $ne: true },
        'open.cancelled': { $ne: true },
        'open.skipped': { $ne: true },
        'open.voided': { $ne: true },
      }],
    },
  }));

  const result = await orders.bulkWrite(operations, { ordered: false });
  console.log(`✅ Оновлено замовлень: ${result.modifiedCount}`);

  const left = await orders.countDocuments({
    status: 'expired',
    items: {
      $elemMatch: {
        packed: { $ne: true },
        cancelled: { $ne: true },
        skipped: { $ne: true },
        voided: { $ne: true },
      },
    },
  });
  console.log(`   Залишилось expired із незакритими позиціями: ${left}`);
  if (left !== 0) throw new Error(`Після backfill залишилось ${left} незакритих expired-замовлень`);
  console.log('✅ VERIFY PASS\n');
}

main()
  .catch((err) => {
    console.error('\n❌', err.message, '\n', err.stack);
    process.exitCode = 1;
  })
  .finally(async () => { await mongoose.disconnect().catch(() => {}); });
