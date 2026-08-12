'use strict';

/**
 * GET /api/nav-badges — every sidebar notification count in ONE response.
 *
 * Replaces six separate polled endpoints (incoming products, new products,
 * product feedback, registration requests, shop transfers, unregistered group
 * members). At the old 30s interval an admin fired 6 requests + 6 CORS
 * preflights every half minute; app.zlotoweczka → api.zlotoweczka is
 * cross-origin, so every one of them was a non-simple request.
 *
 * Two properties of the old shape are preserved deliberately:
 *   - Role gating is per-count and matches the source endpoints exactly
 *     (staff: incoming + feedback · admin: registration + transfers + members ·
 *     any role: new products). A caller only pays for what it may see.
 *   - One failing source must not blank the whole sidebar. Each count settles
 *     independently and falls back to 0 — that isolation is what six separate
 *     react-query calls used to give us for free. It matters most for
 *     `unregisteredMembers`, which hits the live Telegram API.
 *
 * Counts only: no documents are shipped. The old incoming-products badge
 * fetched every pending product doc just to read `.length`.
 */

const express = require('express');
const { asyncHandler } = require('../utils/errors');
const Product = require('../models/Product');
const Block = require('../models/Block');
const ProductFeedback = require('../models/ProductFeedback');
const RegistrationRequest = require('../models/RegistrationRequest');
const ShopTransferRequest = require('../models/ShopTransferRequest');
const { newProductsPipeline } = require('./products');

const router = express.Router();

const NEW_PRODUCTS_DAYS = 14;

// Mirrors GET /api/blocks/incoming/products — products awaiting placement into
// a block. See that route for why restoredFromArchive ignores the qty filter.
async function countIncomingProducts() {
  const assignedIds = await Block.distinct('productIds');
  return Product.countDocuments({
    status: 'pending',
    source: { $in: ['receive', 'receipt'] },
    _id: { $nin: assignedIds },
    $or: [
      { quantity: { $gt: 0 } },
      { restoredFromArchive: true },
    ],
  });
}

// Same definition of "new" as GET /api/v1/products/new-list (shared pipeline),
// over a fixed 14-day window.
async function countNewProducts() {
  const cutoff = new Date(Date.now() - NEW_PRODUCTS_DAYS * 24 * 60 * 60 * 1000);
  const [result] = await Product.aggregate([
    ...newProductsPipeline(cutoff),
    { $count: 'count' },
  ]);
  return result?.count ?? 0;
}

// Cheap count from the latest persisted group state. Deliberate live Telegram
// checks happen only from the Groups admin page; navigation polling must never
// fan out hundreds of getChatMember calls.
async function countUnregisteredGroupMembers() {
  const { getMembersWithStatus } = require('../services/groupMemberSync');
  const { getAllowedGroupIds } = require('./admin');
  const groupIds = await getAllowedGroupIds();
  const results = await Promise.all(groupIds.map((id) => getMembersWithStatus(id)));
  const present = new Set(['member', 'administrator', 'creator', 'restricted']);
  return results.flat().filter((r) => {
    if (r.isRegistered) return false;
    const status = r.member?.telegramStatus || '';
    if (present.has(status)) return true;
    // Legacy rows created before live statuses existed: keep the old badge
    // behaviour until the first audit tells us something more precise.
    return !status && r.member?.left === false;
  }).length;
}

// Resolves to the count, or to 0 if the source throws. Never rejects.
async function safeCount(key, enabled, fn) {
  if (!enabled) return 0;
  try {
    return await fn();
  } catch (err) {
    return 0;
  }
}

router.get('/', asyncHandler(async (req, res) => {
  const role = req.telegramUser?.role || '';
  const isAdmin = role === 'admin';
  const isStaff = isAdmin || role === 'warehouse';

  const [
    incomingProducts,
    newProducts,
    productFeedback,
    registrationRequests,
    shopTransfers,
    unregisteredMembers,
  ] = await Promise.all([
    safeCount('incomingProducts', isStaff, countIncomingProducts),
    safeCount('newProducts', Boolean(role), countNewProducts),
    safeCount('productFeedback', isStaff, () => ProductFeedback.countDocuments({ status: 'open' })),
    safeCount('registrationRequests', isAdmin, () => RegistrationRequest.countDocuments({ status: 'pending' })),
    safeCount('shopTransfers', isAdmin, () => ShopTransferRequest.countDocuments({ status: 'pending' })),
    safeCount('unregisteredMembers', isAdmin, countUnregisteredGroupMembers),
  ]);

  res.json({
    incomingProducts,
    newProducts,
    productFeedback,
    registrationRequests,
    shopTransfers,
    unregisteredMembers,
  });
}));

module.exports = router;
