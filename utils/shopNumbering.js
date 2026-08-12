'use strict';

// Box numbers for packing. Each SHOP (by shopId) participating in an ordering
// session gets ONE stable sequential number, so warehouse staff label boxes with
// a digit instead of a shop name. Rules (decided with the operator):
//   • Identity = shopId. Two sellers of the same shop → one shared number.
//   • Order = alphabetical by shop name.
//   • Scope = this session only; restarts at 1 each session, independent per group.
//   • Frozen once at picking start — the set of shops is fixed by then because the
//     ordering window and picking are mutually exclusive in time.

const OrderingSession = require('../models/OrderingSession');

// Build the alphabetical shopId → number list from a session's orders.
// Returns [{ shopId, shopName, number }] sorted by number (1..N).
function computeShopNumbers(orders = []) {
  const byShop = new Map(); // shopId → shopName (first seen)
  for (const o of orders) {
    const sid = String(o.shopId || o.buyerSnapshot?.shopId || '');
    if (!sid) continue;
    if (!byShop.has(sid)) byShop.set(sid, o.buyerSnapshot?.shopName || o.shopName || '');
  }
  const sorted = [...byShop.entries()].sort((a, b) =>
    String(a[1]).localeCompare(String(b[1]), 'uk', { sensitivity: 'base', numeric: true }),
  );
  return sorted.map(([shopId, shopName], i) => ({ shopId, shopName, number: i + 1 }));
}

// Freeze the box numbers onto the session if not already present. Idempotent:
// once a session has numbers they are never recomputed (they must stay stable for
// the whole pick, and the shop set can't change after the window closed).
// Best-effort — numbering must never block a picking start.
async function ensureSessionShopNumbers(sessionId, orders = []) {
  const sid = String(sessionId || '');
  if (!sid) return [];
  try {
    const existing = await OrderingSession.findById(sid, 'shopNumbers').lean();
    if (Array.isArray(existing?.shopNumbers) && existing.shopNumbers.length) {
      return existing.shopNumbers;
    }
    const numbers = computeShopNumbers(orders);
    if (!numbers.length) return [];
    await OrderingSession.updateOne({ _id: sid }, { $set: { shopNumbers: numbers } });
    return numbers;
  } catch (err) {
    return [];
  }
}

// Late arrivals: a shop whose order reached the session AFTER the numbers were
// frozen has no number at all. It cannot be slotted alphabetically — the boxes
// for 1..N are already physically labelled and renumbering them would make every
// existing label lie — so it gets the next free number and sits at the tail.
// Returns the assigned (or already-present) number, or null when there is nothing
// to append to (numbers not frozen yet / session gone). Best-effort: numbering
// must never break the reconcile that calls it.
//
// The guards make the read→compute→write sequence safe under concurrency: the
// $ne blocks a double-assign for the same shop, and the array-length pair pins
// the write to the exact list we computed `next` from, so two late shops racing
// can never both take N+1 (the loser retries and takes N+2).
async function assignLateShopNumber(sessionId, shopId, shopName = '', { maxRetries = 3 } = {}) {
  const sid  = String(sessionId || '');
  const shid = String(shopId || '');
  if (!sid || !shid) return null;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const sess = await OrderingSession.findById(sid, 'shopNumbers').lean();
      if (!sess) return null;
      const list = Array.isArray(sess.shopNumbers) ? sess.shopNumbers : [];
      const existing = list.find((s) => String(s.shopId) === shid);
      if (existing) return existing.number;
      // Not frozen yet → picking has not started; start-session will number this
      // shop normally as part of the alphabetical pass.
      if (!list.length) return null;

      const next = list.reduce((max, s) => Math.max(max, Number(s.number) || 0), 0) + 1;
      const res = await OrderingSession.updateOne(
        {
          _id: sid,
          'shopNumbers.shopId': { $ne: shid },
          [`shopNumbers.${list.length - 1}`]: { $exists: true },
          [`shopNumbers.${list.length}`]:     { $exists: false },
        },
        { $push: { shopNumbers: { shopId: shid, shopName: shopName || '', number: next } } },
      );
      if ((res.modifiedCount ?? res.nModified ?? 0) > 0) return next;
    }
    return null;
  } catch (err) {
    return null;
  }
}

// Turn a session's frozen shopNumbers array into fast lookup maps. Keyed by both
// shopId (primary) and shopName (fallback for older tasks that predate the shopId
// field on picking-task items).
function buildShopNumberLookup(shopNumbers = []) {
  const byId = new Map();
  const byName = new Map();
  for (const s of shopNumbers || []) {
    if (s.shopId) byId.set(String(s.shopId), s.number);
    if (s.shopName) byName.set(String(s.shopName), s.number);
  }
  return { byId, byName };
}

module.exports = { computeShopNumbers, ensureSessionShopNumbers, assignLateShopNumber, buildShopNumberLookup };
