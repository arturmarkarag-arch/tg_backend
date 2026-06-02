'use strict';

// ─── One-shot picking-state wipe (test DB only) ─────────────────────────────
// Drops EVERY PickingTask, Order and OrderingSession so the new session-status
// model (pickingStatus + events) starts on a clean slate. Product, DeliveryGroup
// and User are NEVER touched — those describe the warehouse and people, not the
// transient picking cycle.
//
// Usage (from the server/ dir):
//   node scripts/cleanPickingState.js          # confirm prompt via env CLEAN_PICKING_STATE=yes
//   CLEAN_PICKING_STATE=yes node scripts/cleanPickingState.js
//
// This is destructive and is NOT auto-wired into startup. Production must never
// run it — orders would vanish. The session invariant guarding the picking
// lifecycle (see memory: [[session-invariant]]) is unaffected by this wipe.

// Pin the env to the repo-root .env (same as index.js), NOT a cwd-relative .env —
// otherwise running from server/ silently loads a stale server/.env (wrong DB).
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose       = require('mongoose');
const PickingTask    = require('../models/PickingTask');
const Order          = require('../models/Order');
const OrderingSession = require('../models/OrderingSession');

async function main() {
  if (process.env.CLEAN_PICKING_STATE !== 'yes') {
    console.error('Refusing to run: set CLEAN_PICKING_STATE=yes to confirm wipe.');
    process.exit(2);
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required (.env)');

  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('[cleanPickingState] connected');

  const [tasks, orders, sessions] = await Promise.all([
    PickingTask.deleteMany({}),
    Order.deleteMany({}),
    OrderingSession.deleteMany({}),
  ]);

  console.log(`[cleanPickingState] PickingTask     deleted: ${tasks.deletedCount   ?? tasks.n   ?? 0}`);
  console.log(`[cleanPickingState] Order           deleted: ${orders.deletedCount  ?? orders.n  ?? 0}`);
  console.log(`[cleanPickingState] OrderingSession deleted: ${sessions.deletedCount ?? sessions.n ?? 0}`);
  console.log('[cleanPickingState] Product / DeliveryGroup / User untouched (by design).');

  await mongoose.disconnect();
}

// Guard so `require()` from another module never auto-fires the wipe — only a
// direct `node scripts/cleanPickingState.js` invocation triggers main().
if (require.main === module) {
  main().catch((err) => {
    console.error('[cleanPickingState] fatal:', err);
    process.exit(1);
  });
}

module.exports = { main };
