/**
 * One-off repair: PARK active orders that got stranded by the old unassign bug.
 *
 * Stranded = active order ('new'|'in_progress') whose shopId is set but does NOT
 * match the buyer's current user.shopId (or the buyer has no shop). Such an order
 * was left behind on the old shop and a normal assignment can never reunite it.
 * Parking it (shopId=null + cleared buyerSnapshot shop fields) makes the very
 * next proper assignment via migrateSellerShop pick it up and carry it along.
 *
 * SAFE: orders already in the picking pipeline (warehouse owns them) are SKIPPED.
 * Reversible: parking just detaches the shop; no data is destroyed.
 *
 * Usage:
 *   node scripts/repair-stranded-orders.js          # DRY-RUN (default, no writes)
 *   node scripts/repair-stranded-orders.js --apply   # actually park them
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const users = await db.collection('users')
    .find({}, { projection: { telegramId: 1, shopId: 1, firstName: 1, lastName: 1 } })
    .toArray();
  const userByTg = new Map(users.map((u) => [String(u.telegramId), u]));

  const shops = await db.collection('shops')
    .find({}, { projection: { name: 1 } }).toArray();
  const shopName = new Map(shops.map((s) => [String(s._id), s.name]));

  const active = await db.collection('orders')
    .find({ status: { $in: ['new', 'in_progress'] } })
    .toArray();

  const stranded = [];
  for (const o of active) {
    if (o.shopId == null) continue; // already parked
    const u = userByTg.get(String(o.buyerTelegramId));
    const uShop = u && u.shopId ? String(u.shopId) : null;
    const oShop = String(o.shopId);
    if (uShop === oShop) continue; // correctly placed
    stranded.push({ o, u, uShop, oShop });
  }

  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`);
  console.log(`Active orders: ${active.length} | stranded candidates: ${stranded.length}\n`);

  let parked = 0;
  let skippedPipeline = 0;

  for (const { o, u, uShop, oShop } of stranded) {
    const inPipeline = await db.collection('pickingtasks').findOne({
      'items.orderId': o._id,
      status: { $in: ['pending', 'locked', 'completed'] },
    });
    const who = u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '(no user)';
    const line = `order ${o._id} | buyer ${o.buyerTelegramId} ${who} | on [${shopName.get(oShop) || oShop}] | seller on [${uShop ? shopName.get(uShop) || uShop : 'NONE'}]`;

    if (inPipeline) {
      skippedPipeline += 1;
      console.log(`  SKIP (in picking pipeline): ${line}`);
      continue;
    }

    if (!APPLY) {
      console.log(`  WOULD PARK: ${line}`);
      parked += 1;
      continue;
    }

    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await db.collection('orders').updateOne(
          { _id: o._id, status: { $in: ['new', 'in_progress'] } },
          {
            $set: {
              shopId: null,
              'buyerSnapshot.shopId': null,
              'buyerSnapshot.shopName': '',
              'buyerSnapshot.shopCity': '',
            },
            $push: {
              history: {
                at: new Date(),
                by: 'system',
                byName: 'repair-stranded-orders',
                byRole: 'system',
                action: 'seller_unassigned_order_parked',
                meta: { fromShopId: oShop, reason: 'repair_stranded_orders' },
              },
            },
          },
          { session },
        );
      });
      parked += 1;
      console.log(`  PARKED: ${line}`);
    } finally {
      session.endSession();
    }
  }

  console.log(`\n${APPLY ? 'Parked' : 'Would park'}: ${parked} | skipped (pipeline): ${skippedPipeline}`);
  if (!APPLY) console.log('Re-run with --apply to perform the writes.');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
