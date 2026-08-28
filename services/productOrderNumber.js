'use strict';

/**
 * One ordering lane for every Product.orderNumber mutation/automatic allocation.
 *
 * The important invariant is stronger than "reserve max+1 atomically": the same
 * distributed lock must stay held until the caller's Mongo transaction COMMITS.
 * Otherwise another creator/reorder could occupy a reserved number in the small
 * window between reservation and commit.
 *
 * `withProductOrderNumberLock()` therefore passes a scoped allocator to its
 * callback. Automatic Product-creating commands allocate only while that lock is
 * already held, then keep the lock through their transaction commit. Manual
 * create/reorder commands use the same lane. Counter keeps the sequence durable;
 * every allocation is also floored at the current active Product max so older
 * manual data cannot move the allocator backwards. Gaps after aborted commands
 * are allowed; uniqueness and monotonicity are the contract.
 */
const { AsyncLocalStorage } = require('async_hooks');
const Counter = require('../models/Counter');
const Product = require('../models/Product');
const { withLock } = require('../utils/lock');

const COUNTER_NAME = 'productOrderNumber';
const LOCK_NAME = 'product-order-number';
const lockContext = new AsyncLocalStorage();

function normalizeCount(count) {
  const amount = Number(count);
  if (!Number.isInteger(amount) || amount < 1) throw new Error('invalid product order number count');
  return amount;
}

// MUST only run while LOCK_NAME is already held by withProductOrderNumberLock.
async function allocateProductOrderNumbersWhileLocked(count = 1) {
  const amount = normalizeCount(count);

  const maxProduct = await Product.findOne(
    { status: { $ne: 'archived' } },
    'orderNumber',
  ).sort({ orderNumber: -1 }).lean();
  const activeMax = Math.max(0, Number(maxProduct?.orderNumber || 0));

  // Pipeline update can atomically do max(existingCounter, activeMax) + amount.
  // Equality fields from the upsert query seed `name` on first creation.
  const counter = await Counter.findOneAndUpdate(
    { name: COUNTER_NAME },
    [{
      $set: {
        seq: {
          $add: [
            { $max: [{ $ifNull: ['$seq', 0] }, activeMax] },
            amount,
          ],
        },
      },
    }],
    { upsert: true, new: true },
  ).lean();

  const last = Number(counter?.seq || 0);
  const first = last - amount + 1;
  return { first, last, numbers: Array.from({ length: amount }, (_, i) => first + i) };
}

const scopedAllocator = {
  allocateMany: allocateProductOrderNumbersWhileLocked,
  allocateOne: async () => {
    const { first } = await allocateProductOrderNumbersWhileLocked(1);
    return first;
  },
};

async function withProductOrderNumberLock(fn) {
  if (typeof fn !== 'function') throw new TypeError('product order-number lock callback required');

  // Re-entrant inside one async call-chain: command handlers keep this lane held
  // through Mongo commit, while deep projector helpers may still allocate a
  // number. A nested lock acquisition would deadlock without this context.
  if (lockContext.getStore()?.held === true) return fn(scopedAllocator);

  return withLock(
    LOCK_NAME,
    async () => lockContext.run({ held: true }, () => fn(scopedAllocator)),
    { ttlMs: 120_000, waitMs: 60_000 },
  );
}

// Compatibility helpers for callers that only need a durable reservation. New
// Product-creating transactions should prefer withProductOrderNumberLock() and
// keep the lock until commit.
async function allocateProductOrderNumbers(count = 1) {
  return withProductOrderNumberLock(({ allocateMany }) => allocateMany(count));
}

async function allocateProductOrderNumber() {
  return withProductOrderNumberLock(({ allocateOne }) => allocateOne());
}

module.exports = {
  allocateProductOrderNumber,
  allocateProductOrderNumbers,
  withProductOrderNumberLock,
};
