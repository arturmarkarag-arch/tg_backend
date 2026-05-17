'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { appError, asyncHandler } = require('../utils/errors');
const { telegramAuth, requireTelegramRole, requireTelegramRoles } = require('../middleware/telegramAuth');

const ShopTransferRequest = require('../models/ShopTransferRequest');
const Shop  = require('../models/Shop');
const User  = require('../models/User');
const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const { migrateSellerShop } = require('../services/migrateSellerShop');
const { invalidateShop } = require('../utils/modelCache');
const { countCartItems, computeTargetShopState } = require('../utils/shopConflict');
const { snapshotClearedCart } = require('../services/clearedCart');
const { getIO } = require('../socket');

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

async function buildConflictSnapshot(toShopId, fromShopId, sellerCartState) {
  const { sellers, activeOrders, distinctBuyerCount, hasConflict } =
    await computeTargetShopState(toShopId);

  // Primary (first) seller kept for backward-compatible display fields
  const targetSeller = sellers[0] || null;

  // Active orders for source shop (will follow seller via migrateSellerShop)
  const sourceActiveOrder = await Order.findOne(
    { shopId: fromShopId, status: { $in: ['new', 'in_progress'] } }, '_id'
  ).lean();

  let targetSellerCartHasItems = false;
  let targetSellerCartItemCount = 0;
  let targetSellerHasActiveOrder = false;
  let targetSellerActiveOrderId = null;

  if (targetSeller) {
    const targetCartItems = countCartItems(targetSeller.cartState);
    targetSellerCartHasItems = targetCartItems > 0;
    targetSellerCartItemCount = targetCartItems;
    targetSellerHasActiveOrder = activeOrders.length > 0;
    targetSellerActiveOrderId = activeOrders[0]?._id || null;
  }

  const cartItems = countCartItems(sellerCartState);

  return {
    targetShopHasSeller: !!targetSeller,
    targetShopSellerName: targetSeller
      ? [targetSeller.firstName, targetSeller.lastName].filter(Boolean).join(' ')
      : '',
    targetShopSellerTelegramId: targetSeller?.telegramId || '',
    targetSellerCartHasItems,
    targetSellerCartItemCount,
    targetSellerHasActiveOrder,
    targetSellerActiveOrderId,
    sourceShopHasActiveOrder: !!sourceActiveOrder,
    sourceShopActiveOrderId: sourceActiveOrder?._id || null,
    cartHasItems: cartItems > 0,
    cartItemCount: cartItems,
    // New: full picture of the target shop at submission time (display/audit only)
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
  }).lean();
  if (existing) throw appError('transfer_already_pending');

  const sellerFull = await User.findOne({ telegramId: seller.telegramId }, 'cartState').lean();
  const conflictSnapshot = await buildConflictSnapshot(toShopId, seller.shopId, sellerFull?.cartState);

  const request = await ShopTransferRequest.create({
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

  res.status(201).json(request);
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
  res.json(updated);
}));

// ─── GET /api/shop-transfer/my  (seller checks own request) ──────────────────
router.get('/my', telegramAuth, requireTelegramRole('seller'), asyncHandler(async (req, res) => {
  const seller = req.telegramUser;
  const request = await ShopTransferRequest.findOne({
    sellerTelegramId: seller.telegramId,
    status: 'pending',
  }).lean();
  res.json(request || null);
}));

// ─── GET /api/shop-transfer  (admin: list all pending) ───────────────────────
router.get('/', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  const query = ['pending', 'approved', 'rejected', 'cancelled'].includes(status)
    ? { status }
    : { status: 'pending' };

  const requests = await ShopTransferRequest.find(query)
    .sort({ createdAt: -1 })
    .lean();
  res.json(requests);
}));

// ─── POST /api/shop-transfer/:id/approve  (admin approves) ───────────────────
router.post('/:id/approve', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const admin = req.telegramUser;
  const { cartDecision, displacedSellerDecision, overrideToShopId } = req.body;

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

  // requestDoc.conflictSnapshot is kept ONLY for display/audit ("what was true when
  // the seller asked"). NEVER drive safety guards off it — between submit and approve
  // either seller can add or clear cart items. Recompute requirements from fresh reads.
  const requestingSellerFresh = await User.findOne(
    { telegramId: requestDoc.sellerTelegramId }, 'cartState',
  ).lean();
  if (countCartItems(requestingSellerFresh?.cartState) > 0 && !['clear', 'keep'].includes(cartDecision)) {
    throw appError('transfer_cart_decision_required');
  }

  // Fresh displaced-seller check against the EFFECTIVE target shop. This also covers
  // the admin-override path, which previously bypassed this guard entirely and could
  // silently wipe the displaced seller's cart.
  const targetSellerFresh = requestDoc.isProfileOnly ? null : await User.findOne(
    { shopId: String(effectiveToShopId), role: 'seller', telegramId: { $ne: requestDoc.sellerTelegramId } },
    'cartState',
  ).lean();
  if (targetSellerFresh && countCartItems(targetSellerFresh.cartState) > 0
      && !['clear_cart', 'keep_cart'].includes(displacedSellerDecision)) {
    return res.status(400).json({ error: 'displaced_seller_decision_required', message: 'Потрібно прийняти рішення щодо кошика поточного продавця цільового магазину.' });
  }

  // ДІРКА 3+4 (варіант B): refuse to push a seller into a shop that is ALREADY in a
  // conflict (2+ other sellers, or active orders from 2+ distinct buyers). Displacing
  // a single seller is fine — that is the normal path. A pre-existing conflict must be
  // resolved in the conflicts view first, otherwise approving here silently grows it.
  if (!requestDoc.isProfileOnly && effectiveToShopId) {
    const targetState = await computeTargetShopState(effectiveToShopId, requestDoc.sellerTelegramId);
    if (targetState.hasConflict) {
      throw appError('transfer_target_in_conflict', {
        sellerCount: targetState.sellers.length,
        buyerCount: targetState.distinctBuyerCount,
      });
    }
  }

  let migrationResult = null;
  let resolvedRequest = null;

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

      // In-tx re-check closes the TOCTOU window: a concurrent assignment could have
      // pushed a second seller onto the target between the pre-tx guard and here.
      const targetStateTx = await computeTargetShopState(
        effectiveToShopId, request.sellerTelegramId, session,
      );
      if (targetStateTx.hasConflict) {
        throw appError('transfer_target_in_conflict', {
          sellerCount: targetStateTx.sellers.length,
          buyerCount: targetStateTx.distinctBuyerCount,
        });
      }

      // Handle displaced seller (if target shop is occupied)
      const targetCurrentSeller = await User.findOne({
        shopId: String(effectiveToShopId),
        role: 'seller',
        telegramId: { $ne: request.sellerTelegramId },
      }).session(session);

      if (targetCurrentSeller) {
        // Fresh in-tx check (targetCurrentSeller is a full session doc with cartState).
        // Closes the submit→approve staleness window completely.
        const targetCartHasItems = countCartItems(targetCurrentSeller.cartState) > 0;
        if (targetCartHasItems && !['clear_cart', 'keep_cart'].includes(displacedSellerDecision)) {
          throw appError('transfer_target_occupied');
        }

        const displacedPatch = { shopId: null, deliveryGroupId: '', warehouseZone: '' };

        if (displacedSellerDecision === 'clear_cart') {
          // Soft-delete: snapshot before wiping so admin can restore within 7 days.
          await snapshotClearedCart({
            session,
            owner: targetCurrentSeller,
            clearedBy: admin.telegramId,
            clearedByName: [admin.firstName, admin.lastName].filter(Boolean).join(' '),
            reason: `shop_transfer_displaced:${String(request._id)}`,
            shopId: String(effectiveToShopId),
            shopName: toShop.name || '',
          });
          displacedPatch['cartState.orderItems'] = {};
          displacedPatch['cartState.orderItemIds'] = [];
          displacedPatch['cartState.updatedAt'] = new Date();
        }

        await User.updateOne(
          { telegramId: targetCurrentSeller.telegramId },
          { $set: displacedPatch },
          { session }
        );

        // Якщо замовлення витісненого продавця вже в PickingTask (склад взяв в роботу) —
        // воно вже "знято" зі snapshot магазину і нікуди не рухається. Не чіпаємо.
        // Якщо ще не в pipeline — паркуємо: відв'язуємо від магазину, щоб замовлення
        // пішло за продавцем після наступного призначення через migrateSellerShop.
        const displacedActiveOrder = await Order.findOne(
          {
            buyerTelegramId: targetCurrentSeller.telegramId,
            shopId: String(effectiveToShopId),
            status: { $in: ['new', 'in_progress'] },
          },
          '_id',
        ).session(session).lean();

        if (displacedActiveOrder) {
          const inPipeline = await PickingTask.exists({
            'items.orderId': displacedActiveOrder._id,
            status: { $in: ['pending', 'locked', 'completed'] },
          }).session(session);

          if (!inPipeline) {
            // Не в роботі складу — паркуємо, щоб migrateSellerShop підхопив при наступному призначенні
            await Order.updateOne(
              { _id: displacedActiveOrder._id },
              {
                $set: {
                  shopId: null,
                  'buyerSnapshot.shopId': null,
                  'buyerSnapshot.shopName': '',
                  'buyerSnapshot.shopCity': '',
                },
                $push: {
                  history: {
                    at: new Date(),
                    by: String(admin.telegramId),
                    byName: [admin.firstName, admin.lastName].filter(Boolean).join(' '),
                    byRole: admin.role,
                    action: 'seller_displaced_order_parked',
                    meta: {
                      fromShop: toShop.name || '',
                      reason: `shop_transfer_approved:${String(request._id)}`,
                      incomingSeller: request.sellerName || '',
                    },
                  },
                },
              },
              { session },
            );
          }
          // Якщо inPipeline — замовлення залишається на магазині, склад доробляє його як є
        }
      }

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

      // For initial assignment: just set the shop directly (no order to migrate, no lastSeller, no history)
      // For shop change: use full migration service
      if (isAssignment) {
        const warehouseZone = toShop.deliveryGroupId
          ? (await require('../models/DeliveryGroup').findById(toShop.deliveryGroupId).lean())?.name || ''
          : '';
        await User.updateOne(
          { telegramId: seller.telegramId },
          { $set: {
            shopId: toShop._id,
            deliveryGroupId: toShop.deliveryGroupId || '',
            warehouseZone,
          }},
          { session }
        );
        const assignOldShopId = seller.shopId ? String(seller.shopId) : '';
        const assignNewShopId = String(toShop._id);
        migrationResult = {
          prevGroupId: null,
          newGroupId: toShop.deliveryGroupId || null,
          movedOrder: false,
          invalidate: async () => {
            if (assignOldShopId) await invalidateShop(assignOldShopId);
            if (assignNewShopId) await invalidateShop(assignNewShopId);
          },
        };
      } else {
        migrationResult = await migrateSellerShop({
          session,
          existingUser: seller,
          newShopFull: toShop,
          actor: admin,
          reason: `admin_transfer_approved:${String(request._id)}`,
          resetCartItems: cartDecision === 'clear',
          resetCartNavigation: true,
          clearCartReservation: true,
          pushHistory: true,
          updateLastSeller: true,
        });
      }

      // Mark request resolved
      request.status = 'approved';
      request.resolvedAt = new Date();
      request.resolvedBy = admin.telegramId;
      request.resolvedByName = [admin.firstName, admin.lastName].filter(Boolean).join(' ');
      request.cartDecision = cartDecision || null;
      request.displacedSellerDecision = displacedSellerDecision || null;
      request.displacedSellerTelegramId = targetCurrentSeller?.telegramId || '';
      await request.save({ session });

      resolvedRequest = request.toObject();
    });
  } finally {
    session.endSession();
  }

  // Post-commit cache invalidation — outside withTransaction so other workers
  // don't repopulate L1 with pre-commit reads.
  if (migrationResult?.invalidate) {
    try { await migrationResult.invalidate(); }
    catch (e) { console.warn('[shopTransfer approve] cache invalidate failed:', e?.message); }
  }

  // Notify dashboards AFTER commit (same pattern as /me/shop)
  try {
    const io = getIO();
    if (io && migrationResult) {
      const { prevGroupId, newGroupId, movedOrder } = migrationResult;
      if (prevGroupId) io.to(`picking_group_${prevGroupId}`).emit('shop_status_changed', { groupId: prevGroupId });
      if (newGroupId && newGroupId !== prevGroupId) {
        io.to(`picking_group_${newGroupId}`).emit('shop_status_changed', { groupId: newGroupId });
        io.emit('delivery_groups_updated');
      }
      if (movedOrder) {
        io.emit('user_order_updated', { buyerTelegramId: requestDoc.sellerTelegramId });
      }
      // Notify the approved seller that their shop changed
      io.emit('user_shop_changed', { telegramId: requestDoc.sellerTelegramId });
      // Notify displaced seller (if any) that they were removed from their shop
      const displacedId = resolvedRequest?.displacedSellerTelegramId;
      if (displacedId) {
        io.emit('user_shop_changed', { telegramId: displacedId });
      }
    }
  } catch (e) {
    console.warn('[shopTransfer approve] socket emit failed:', e?.message);
  }

  res.json(resolvedRequest);
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

  res.json(request);
}));

module.exports = router;
