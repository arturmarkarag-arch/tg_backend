'use strict';

const OrderingSession = require('../models/OrderingSession');
const Counter = require('../models/Counter');
const { withLock } = require('./lock');

/**
 * Assign a per-group sequential number to an OrderingSession the first time it
 * gains real content (called on order placement). Idempotent and gap-free:
 *
 *   - If the session already has a seq → return it, no work.
 *   - Otherwise take a per-GROUP lock, re-read under the lock, and only then
 *     increment the Counter. Incrementing strictly inside the lock (after
 *     confirming seq is still unset) guarantees no two concurrent first-orders
 *     each consume a number — so the visible sequence has no holes.
 *
 * The Counter name is scoped per delivery group (`session-seq:<groupId>`), so
 * each group counts its own sessions independently ("Доставка Четвер · Сесія №12").
 *
 * Best-effort: any failure (lock contention timeout, etc.) leaves seq null and
 * is swallowed by the caller — numbering must never block an order from saving.
 *
 * @param {string} sessionId  OrderingSession._id
 * @param {string} groupId    delivery group id
 * @returns {Promise<number|null>}  the assigned (or existing) seq, or null
 */
async function ensureSessionSeq(sessionId, groupId) {
  const sid = String(sessionId || '');
  const gid = String(groupId || '');
  if (!sid || !gid) return null;

  const current = await OrderingSession.findById(sid, 'seq').lean();
  if (!current) return null;
  if (current.seq != null) return current.seq;

  return withLock(
    `session-seq:${gid}`,
    async () => {
      // Re-read under the lock — a concurrent first-order may have assigned it
      // between our check above and acquiring the lock.
      const fresh = await OrderingSession.findById(sid, 'seq').lean();
      if (fresh && fresh.seq != null) return fresh.seq;

      const counter = await Counter.findOneAndUpdate(
        { name: `session-seq:${gid}` },
        { $inc: { seq: 1 } },
        { upsert: true, new: true },
      );
      // The `seq: null` filter is the final guard: if somehow another path set it
      // first, this no-ops and we keep the already-assigned value below.
      await OrderingSession.updateOne(
        { _id: sid, seq: null },
        { $set: { seq: counter.seq } },
      );
      const after = await OrderingSession.findById(sid, 'seq').lean();
      return after?.seq ?? counter.seq;
    },
    { ttlMs: 10_000, waitMs: 8_000 },
  );
}

module.exports = { ensureSessionSeq };
