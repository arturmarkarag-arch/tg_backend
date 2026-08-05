'use strict';
/**
 * purgeGhostOrders — removes the `cancelled` husks left by the OLD behaviour.
 *
 * Before the fix in routes/orders.js, emptying a cart flipped the order to
 * `cancelled` and kept the document. The result is a row with zero items whose
 * whole story is "a seller added a product and removed it again" — no picking,
 * no warehouse verdict, no money. It carries no audit value and shows up in any
 * list that does not filter the status.
 *
 * routes/orders.js now DELETES such an order as the last position leaves (see
 * orderNeverLived), so this script only clears the rows created before that.
 *
 * It refuses to touch anything that ever lived:
 *   - items must be completely empty — a single `cancelled`/`skipped` row means
 *     the warehouse ruled on it, and that ruling is the audit; keep it;
 *   - no PickingTask may reference the order;
 *   - history may only contain the buyer's own edits plus the automatic
 *     `auto_closed_empty` entry (written by the app or by closeEmptyOrders.js).
 *     Any other actor — staff reassignment, parking, OOS — disqualifies the row.
 *
 * Usage:
 *   node scripts/purgeGhostOrders.js            # dry-run, lists what it would delete
 *   node scripts/purgeGhostOrders.js --execute  # actually deletes them
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');

const EXECUTE = process.argv.includes('--execute');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`[purgeGhostOrders] ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} — connected`);

  const candidates = await Order.find({
    status: 'cancelled',
    $or: [{ items: { $size: 0 } }, { items: { $exists: false } }],
  }).lean();

  console.log(`[purgeGhostOrders] ${candidates.length} cancelled order(s) with no items`);

  const ghosts = [];
  for (const o of candidates) {
    const foreignActor = (o.history || []).find(
      (h) => String(h.by) !== String(o.buyerTelegramId) && h.action !== 'auto_closed_empty',
    );
    if (foreignActor) {
      console.log(`   SKIP #${o.orderNumber} ${o._id} — touched by ${foreignActor.by} (${foreignActor.action})`);
      continue;
    }

    const task = await PickingTask.findOne({ 'items.orderId': o._id }).select('_id').lean();
    if (task) {
      console.log(`   SKIP #${o.orderNumber} ${o._id} — referenced by PickingTask ${task._id}`);
      continue;
    }

    ghosts.push(o);
    console.log(
      `   GHOST #${o.orderNumber} ${o._id} · ${o.buyerSnapshot?.shopName || '—'}` +
      ` · session=${o.orderingSessionId} · created=${new Date(o.createdAt).toISOString()}`,
    );
  }

  if (!EXECUTE) {
    console.log(`[purgeGhostOrders] dry-run — ${ghosts.length} would be deleted. Re-run with --execute.`);
    await mongoose.disconnect();
    return;
  }

  let deleted = 0;
  for (const o of ghosts) {
    // Re-assert emptiness at WRITE time: the ordering window may be open, and a
    // seller could have revived the order between the scan and this delete.
    const res = await Order.deleteOne({
      _id: o._id,
      status: 'cancelled',
      $or: [{ items: { $size: 0 } }, { items: { $exists: false } }],
    });
    deleted += res.deletedCount || 0;
  }
  console.log(`[purgeGhostOrders] deleted ${deleted} order(s)`);
  if (deleted !== ghosts.length) {
    console.log(`[purgeGhostOrders] ${ghosts.length - deleted} skipped — no longer empty`);
  }

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('[purgeGhostOrders] FAILED', e);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
