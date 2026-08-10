'use strict';

// Zero-DB source/behavior smoke for the 2026-08-10 data-hardening patch.
// Safe to run anywhere: reads source files only and exercises the pure
// OrderItem state helper in memory.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isTerminalOrderItem, voidOpenOrderItems } = require('../utils/orderItemState');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const has = (rel, text) => read(rel).includes(text);

function pass(name) { console.log(`✅ ${name}`); }
function must(name, condition) { assert.ok(condition, name); pass(name); }

// Pure item-state behavior.
const order = { items: [
  { packed: false, cancelled: false, skipped: false, voided: false },
  { packed: true, cancelled: false, skipped: false, voided: false },
  { packed: false, cancelled: true, skipped: false, voided: false },
  { packed: false, cancelled: false, skipped: true, voided: false },
] };
const stamp = new Date('2026-08-10T12:00:00.000Z');
must('voidOpenOrderItems changes only the one open row', voidOpenOrderItems(order, { reason: 'order_expired', at: stamp }) === 1);
must('voided row is terminal', isTerminalOrderItem(order.items[0]));
must('packed/cancelled/skipped rows stay un-voided', order.items.slice(1).every((item) => item.voided === false));

// Runtime contracts.
must('OrderItem schema persists voided state', has('models/Order.js', 'voidReason: { type: String') && has('models/Order.js', 'voidedAt: { type: Date'));
must('canonical /upsert-item path assigns session seq', has('routes/orders.js', "[orders/upsert-item] ensureSessionSeq failed"));
must('session seq bootstrap refuses out-of-order numbering', has('utils/sessionSeq.js', 'older content-bearing sessions in group'));
must('stale restore terminalises old order lines', has('routes/orders.js', 'voidOpenOrderItems(staleOrder'));
must('stale expire terminalises order lines', has('routes/orders.js', 'voidOpenOrderItems(order'));
must('bulk historical expire terminalises order lines', has('routes/deliveryGroups.js', "'items.$[open].voided': true"));

const getOrCreate = read('utils/getOrCreateSession.js');
const readPos = getOrCreate.indexOf('const existing = await OrderingSession.findOne({ groupId: gid, openDate });');
const updatePos = getOrCreate.indexOf('return await OrderingSession.findOneAndUpdate', readPos);
must('existing session is read before race-safe upsert', readPos >= 0 && updatePos > readPos);

must('picking stale lock is 5 minutes', has('services/pickingService.js', 'const LOCK_TIMEOUT_MS      =  5 * 60 * 1000'));
must('force claim remains 3 minutes', has('services/pickingService.js', 'const FORCE_CLAIM_AFTER_MS =  3 * 60 * 1000'));
must('manual release endpoint remains installed', has('routes/picking.js', "router.post('/tasks/:taskId/release'"));

must('voided backfill is dry-run by default', has('scripts/backfillVoidedItems.js', "const EXECUTE = process.argv.includes('--execute')"));
must('session seq backfill is dry-run by default', has('scripts/backfillSessionSeq.js', "const EXECUTE = process.argv.includes('--execute')"));

console.log('\nV30 DATA HARDENING CHECK: PASS');
