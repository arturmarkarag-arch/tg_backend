'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { appError, asyncHandler } = require('../utils/errors');
const { telegramAuth, requireTelegramRole, requireTelegramRoles } = require('../middleware/telegramAuth');

const ShopTransferRequest = require('../models/ShopTransferRequest');
const Shop  = require('../models/Shop');
const User  = require('../models/User');
const Order = require('../models/Order');
const { migrateSellerShop } = require('../services/migrateSellerShop');
const { publishShopAssignmentTransition } = require('../services/shopAssignmentCommand');
const { computeTargetShopState } = require('../utils/shopConflict');
const { activeOrderShopFilter } = require('../utils/orderShopFilter');
const { getIO } = require('../socket');
const { withLock } = require('../utils/lock');
const { TRANSFER_FIELDS, toShopTransferDto } = require('../utils/shopTransferDto');

/**
 * Run `fn` while holding the per-seller shop locks for every telegramId in `ids`.
 * Locks are acquired in a STABLE sorted order so two concurrent operations that
 * touch the same pair of sellers can never deadlock (both queue on the lower id
 * first). Duplicate / empty ids are dropped. Mirrors the `user:<id>:shop` lock
 * namespace used by the admin reassignment and transfer-hash redeem paths, so an
 * approve can no longer race a seller's own concurrent action on the same account.
 */
async function withSellerLocks(ids, fn) {
  const unique = [...new Set(ids.filter(Boolean).map(String))].sort();
  const run = (i) => (i >= unique.length
    ? fn()
    : withLock(`user:${unique[i]}:shop`, () => run(i + 1)));
  return run(0);
}

const router = express.Router();

function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('48')  && digits.length === 11) return '+48'  + digits.slice(2);
  if (digits.startsWith('380') && digits.length === 12) return '+380' + digits.slice(3);
  return '+' + digits;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function buildConflictSnapshot(toShopId, fromShopId) {
  const { sellers, activeOrders, distinctBuyerCount, hasConflict } =
    await computeTargetShopState(toShopId);

  const targetSeller = sellers[0] || null;

  // Admins assigned to the target shop — display/audit info only
  const targetAdmins = await User.find(
    { shopId: String(toShopId), role: 'admin' },
    'firstName lastName',
  ).lean();
  const targetShopAdminNames = targetAdmins.map(
    (a) => [a.firstName, a.lastName].filter(Boolean).join(' '),
  );

  const sourceActiveOrder = fromShopId
    ? await Order.findOne(activeOrderShopFilter(fromShopId), '_id').lean()
    : null;

  let targetSellerHasActiveOrder = false;
  let targetSellerActiveOrderId = null;

  if (targetSeller) {
    // Filter to orders placed BY THIS specific seller, not any order on the shop.
    // A shop can have orders from an admin or other staff — attributing those
    // to another seller would produce a false-positive "has active order" note.
    const sellerOrders = activeOrders.filter(
      (o) => String(o.buyerTelegramId) === String(targetSeller.telegramId),
    );
    targetSellerHasActiveOrder = sellerOrders.length > 0;
    targetSellerActiveOrderId = sellerOrders[0]?._id || null;
  }

  return {
    targetShopHasSeller: !!targetSeller,
    targetShopSellerName: targetSeller
      ? [targetSeller.firstName, targetSeller.lastName].filter(Boolean).join(' ')
      : '',
    targetShopSellerTelegramId: targetSeller?.telegramId || '',
    targetSellerHasActiveOrder,
    targetSellerActiveOrderId,
    targetShopAdminNames,
    sourceShopHasActiveOrder: !!sourceActiveOrder,
    sourceShopActiveOrderId: sourceActiveOrder?._id || null,
    targetShopSellerCount: sellers.length,
    targetShopActiveOrderCount: activeOrders.length,
    targetShopDistinctBuyerCount: distinctBuyerCount,
    targetShopHasConflict: hasConflict,
  };
}

// ─── POST /api/shop-transfer  (seller submits a request) ─────────────────────
router.post('/', telegramAuth, requireTelegramRole('seller'), asyncHandler(async (req, res) => {
  const seller = req.telegramUser;
  const { toShopId, firstName, lastName, phoneNumber } = req.body;

  if (!toShopId) throw appError('transfer_shop_required');

  const isAssignment = !seller.shopId;
  if (!isAssignment && String(toShopId) === String(seller.shopId)) throw appError('transfer_same_shop');

  const [fromShop, toShop] = await Promise.all([
    seller.shopId ? Shop.findById(seller.shopId, 'name deliveryGroupId').lean() : Promise.resolve(null),
    Shop.findById(toShopId, 'name deliveryGroupId isActive').lean(),
  ]);
  if (!isAssignment && !fromShop) throw appError('shop_not_found');
  if (!toShop || !toShop.isActive) throw appError('transfer_target_not_found');

  // One pending request per seller at a time (partial unique index handles the DB race,
  // but we throw a nicer error here for the common case)
  const existing = await ShopTransferRequest.findOne({
    sellerTelegramId: seller.telegramId,
    status: 'pending',
  }).select(TRANSFER_FIELDS).lean();
  if (existing) throw appError('transfer_already_pending');

  const conflictSnapshot = await buildConflictSnapshot(toShopId, seller.shopId);

  let request;
  try {
    request = await ShopTransferRequest.create({
      sellerTelegramId: seller.telegramId,
      sellerName: [seller.firstName, seller.lastName].filter(Boolean).join(' '),
      isAssignment,
      fromShopId: seller.shopId || null,
      fromShopName: fromShop?.name || '',
      fromDeliveryGroupId: fromShop?.deliveryGroupId || '',
      toShopId: toShopId || null,
      toShopName: toShop?.name || '',
      toDeliveryGroupId: toShop?.deliveryGroupId || '',
      conflictSnapshot,
      profileUpdate: {
        firstName:   firstName   ? String(firstName).trim()  : '',
        lastName:    lastName    ? String(lastName).trim()   : '',
        phoneNumber: normalizePhone(phoneNumber),
      },
    });
  } catch (err) {
    // The pre-check above is UX only; two tabs can still race it. Translate the
    // partial unique-index backstop into the same business error instead of the
    // meaningless global "Запис з такими даними вже існує" message.
    if (err?.code === 11000) throw appError('transfer_already_pending');
    throw err;
  }

  res.status(201).json(toShopTransferDto(request));
}));

// ─── DELETE /api/shop-transfer/my  (seller cancels own pending request) ───────
router.delete('/my', telegramAuth, requireTelegramRole('seller'), asyncHandler(async (req, res) => {
  const seller = req.telegramUser;
  const updated = await ShopTransferRequest.findOneAndUpdate(
    { sellerTelegramId: seller.telegramId, status: 'pending' },
    { $set: { status: 'cancelled', resolvedAt: new Date() } },
    { new: true }
  );
  if (!updated) throw appError('transfer_not_found');
  res.json(toShopTransferDto(updated));
}));

// ─── GET /api/shop-transfer/my  (seller checks own request) ──────────────────
router.get('/my', telegramAuth, requireTelegramRole('seller'), asyncHandler(async (req, res) => {
  const seller = req.telegramUser;
  const request = await ShopTransferRequest.findOne({
    sellerTelegramId: seller.telegramId,
    status: 'pending',
  }).select(TRANSFER_FIELDS).lean();
  res.json(toShopTransferDto(request));
}));

// ─── GET /api/shop-transfer  (admin: list all pending) ───────────────────────
router.get('/', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  const query = ['pending', 'approved', 'rejected', 'cancelled'].includes(status)
    ? { status }
    : { status: 'pending' };

  const requests = await ShopTransferRequest.find(query)
    .select(TRANSFER_FIELDS)
    .sort({ createdAt: -1 })
    .lean();
  res.json(requests.map(toShopTransferDto));
}));

// ─── POST /api/shop-transfer/:id/approve  (admin approves) ───────────────────
router.post('/:id/approve', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const admin = req.telegramUser;
  const { overrideToShopId } = req.body;

  // Pre-load the request before starting session (read-only, no race risk here)
  const requestDoc = await ShopTransferRequest.findById(req.params.id).lean();
  if (!requestDoc) throw appError('transfer_not_found');
  if (requestDoc.status !== 'pending') throw appError('transfer_not_pending');

  // Admin may override the target shop — validate it exists and is active
  const effectiveToShopId = overrideToShopId || requestDoc.toShopId;
  if (overrideToShopId) {
    const overrideShop = await Shop.findById(overrideToShopId, 'isActive').lean();
    if (!overrideShop || !overrideShop.isActive) throw appError('transfer_target_not_found');
  }

  // Multiple sellers may share one shop. Seller presence is not a conflict,
  // and approval must never evict an existing seller. Active-order conflicts are
  // handled by the dedicated current-session picking conflict flow.

  let migrationResult = null;
  let resolvedRequest = null;

  // Only the incoming seller is mutated. Existing sellers on the destination
  // remain assigned there, so no second account lock is needed.
  await withSellerLocks([requestDoc.sellerTelegramId], async () => {
  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      // Re-read request inside tx for status double-check
      const request = await ShopTransferRequest.findById(requestDoc._id).session(session);
      if (!request || request.status !== 'pending') throw appError('transfer_not_pending');

      // Re-check seller's current shop matches what was recorded (race guard)
      const seller = await User.findOne({ telegramId: request.sellerTelegramId }).session(session);
      if (!seller) throw appError('user_not_found');
      const isProfileOnly = request.isProfileOnly || false;
      const isAssignment = !isProfileOnly && (request.isAssignment || !request.fromShopId);
      if (!isProfileOnly && !isAssignment && String(seller.shopId) !== String(request.fromShopId)) {
        throw appError('transfer_seller_moved');
      }

      // Profile-only: just apply profile patch and skip shop logic entirely
      if (isProfileOnly) {
        const profilePatch = {};
        const pu = request.profileUpdate || {};
        if (pu.firstName)   profilePatch.firstName   = pu.firstName;
        if (pu.lastName)    profilePatch.lastName    = pu.lastName;
        if (pu.phoneNumber) profilePatch.phoneNumber = normalizePhone(pu.phoneNumber);
        if (Object.keys(profilePatch).length > 0) {
          await User.updateOne({ telegramId: seller.telegramId }, { $set: profilePatch }, { session });
        }
        request.status = 'approved';
        request.resolvedAt = new Date();
        request.resolvedBy = admin.telegramId;
        request.resolvedByName = [admin.firstName, admin.lastName].filter(Boolean).join(' ');
        await request.save({ session });
        resolvedRequest = request.toObject();
        migrationResult = { prevGroupId: null, newGroupId: null, movedOrder: false };
        return; // exit withTransaction callback
      }

      // Re-check target shop still active (use admin override if provided)
      const toShop = await Shop.findById(effectiveToShopId).populate('cityId', 'name').session(session);
      if (!toShop || !toShop.isActive) throw appError('transfer_target_not_found');

      // Do not evict or rewrite any seller already assigned to this shop.
      // Multiple sellers are a supported assignment state.

      // Apply profile updates if seller requested them
      const { profileUpdate } = request;
      if (profileUpdate) {
        const profilePatch = {};
        if (profileUpdate.firstName)   profilePatch.firstName   = profileUpdate.firstName;
        if (profileUpdate.lastName)    profilePatch.lastName    = profileUpdate.lastName;
        if (profileUpdate.phoneNumber) profilePatch.phoneNumber = normalizePhone(profileUpdate.phoneNumber);
        if (Object.keys(profilePatch).length > 0) {
          await User.updateOne({ telegramId: request.sellerTelegramId }, { $set: profilePatch }, { session });
          // Keep seller object in sync for migrateSellerShop
          Object.assign(seller, profilePatch);
        }
      }

      // One assignment command for BOTH initial placement and later transfers.
      // migrateSellerShop already handles oldShopId=null and, critically, can
      // re-attach a parked active Order. A raw `User.shopId = ...` here used to
      // strand that order outside the seller's newly assigned shop.
      migrationResult = await migrateSellerShop({
        session,
        existingUser: seller,
        newShopFull: toShop,
        actor: admin,
        reason: `admin_transfer_approved:${String(request._id)}`,
        resetCartNavigation: true,
        pushHistory: true,
        updateLastSeller: true,
      });

      // Mark request resolved
      request.status = 'approved';
      request.resolvedAt = new Date();
      request.resolvedBy = admin.telegramId;
      request.resolvedByName = [admin.firstName, admin.lastName].filter(Boolean).join(' ');
      await request.save({ session });

      resolvedRequest = request.toObject();
    });
  } finally {
    session.endSession();
  }
  }); // withSellerLocks

  // One post-commit publication path for CURRENT assignment topology. It
  // refreshes dashboards even when no Order happened to move.
  if (migrationResult) {
    await publishShopAssignmentTransition(migrationResult);
  }

  try {
    const io = getIO();
    if (io && migrationResult?.assignmentChanged) {
      // Direct notification for the affected seller remains transport-specific;
      // group/cache publication above is canonical and shared by every caller.
      io.emit('user_shop_changed', { telegramId: requestDoc.sellerTelegramId });
    }
  } catch (_) { /* best-effort */ }

  res.json(toShopTransferDto(resolvedRequest));
}));

// ─── POST /api/shop-transfer/:id/reject  (admin rejects) ─────────────────────
router.post('/:id/reject', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const admin = req.telegramUser;
  const { reason } = req.body;

  const request = await ShopTransferRequest.findById(req.params.id);
  if (!request) throw appError('transfer_not_found');
  if (request.status !== 'pending') throw appError('transfer_not_pending');

  request.status = 'rejected';
  request.resolvedAt = new Date();
  request.resolvedBy = admin.telegramId;
  request.resolvedByName = [admin.firstName, admin.lastName].filter(Boolean).join(' ');
  request.rejectReason = reason ? String(reason).trim() : '';
  await request.save();

  res.json(toShopTransferDto(request));
}));

module.exports = router;
