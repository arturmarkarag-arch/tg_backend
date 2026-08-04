'use strict';
/**
 * closeEmptyOrders — one-off cleanup for "ghost" orders.
 *
 * A ghost is an order still in `new`/`in_progress` whose every position is
 * cancelled or skipped: nothing to pick, nothing to deliver, invisible on every
 * board (they count live positions) — but visible to any guard that reads the
 * status alone. That is what blocked the Четвер group's delivery-day change:
 * order #1 (Швіднік), placed 29.07.2026 and emptied by the seller 13 seconds later.
 *
 * routes/orders.js now closes such orders as the last position leaves, so this
 * script is for the rows created before that fix.
 *
 * Usage:
 *   node scripts/closeEmptyOrders.js            # dry-run, lists what it would close
 *   node scripts/closeEmptyOrders.js --execute  # actually closes them
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const Order = require('../models/Order');

const EXECUTE = process.argv.includes('--execute');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`[closeEmptyOrders] ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} — connected`);

  // Active status, and NO position that is still live.
  const ghosts = await Order.find({
    status: { $in: ['new', 'in_progress'] },
    items: { $not: { $elemMatch: { cancelled: { $ne: true }, skipped: { $ne: true } } } },
  }).lean();

  console.log(`[closeEmptyOrders] found ${ghosts.length} empty active order(s)`);
  for (const o of ghosts) {
    console.log(
      `   #${o.orderNumber} ${o._id} · ${o.buyerSnapshot?.shopName || '—'} · group=${o.buyerSnapshot?.deliveryGroupId || '—'}` +
      ` · session=${o.orderingSessionId} · items=${(o.items || []).length} · created=${new Date(o.createdAt).toISOString()}`,
    );
  }

  if (!EXECUTE) {
    console.log('[closeEmptyOrders] dry-run — nothing written. Re-run with --execute to close them.');
    await mongoose.disconnect();
    return;
  }

  let closed = 0;
  for (const o of ghosts) {
    const res = await Order.updateOne(
      { _id: o._id, status: { $in: ['new', 'in_progress'] } },
      {
        $set: { status: 'cancelled' },
        $push: {
          history: {
            at: new Date(),
            by: 'system',
            byName: 'Система',
            byRole: 'system',
            action: 'auto_closed_empty',
            meta: { reason: 'no_live_items', script: 'closeEmptyOrders' },
          },
        },
      },
    );
    closed += res.modifiedCount || 0;
  }
  console.log(`[closeEmptyOrders] closed ${closed} order(s)`);

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('[closeEmptyOrders] FAILED', e);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
