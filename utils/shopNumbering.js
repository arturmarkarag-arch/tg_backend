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
    console.error('[shopNumbering] ensureSessionShopNumbers failed:', err.message);
    return [];
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

module.exports = { computeShopNumbers, ensureSessionShopNumbers, buildShopNumberLookup };
