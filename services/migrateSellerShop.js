// Atomic helper: move seller (User) to a new shop, migrating their active order
// and any related PickingTask shopName references. All writes are scoped to the
// passed Mongo session so the caller can wrap the call in withTransaction().
//
// Returns: { updatedUser, movedOrder, prevGroupId, newGroupId }

const Shop = require('../models/Shop');
const User = require('../models/User');
const DeliveryGroup = require('../models/DeliveryGroup');
const PickingTask = require('../models/PickingTask');
const { findCurrentSessionId } = require('../utils/getOrCreateSession');
const { appError } = require('../utils/errors');
const { invalidateShop } = require('../utils/modelCache');
const { logShopTransition } = require('./shopAudit');
const { assertOperationalShop, assertAssignableShopRole } = require('../utils/shopOperationalState');
const { ORDER_STATUS } = require('../utils/orderStatus');
const { resolveAssignmentDestination } = require('./orderAssignmentRouting');
const {
  resolveSellerAssignmentOrder,
  assertSellerAssignmentOrderInvariant,
} = require('./sellerOrderAssignment');

async function ensureOrderNotInPickingPipeline(orderId, session) {
  const exists = await PickingTask.exists({
    'items.orderId': orderId,
    status: { $in: ['pending', 'locked', 'completed'] },
  }).session(session);
  if (exists) {
    throw appError('order_picking_started');
  }
}

/**
 * @param {Object} params
 * @param {import('mongoose').ClientSession} params.session    Active Mongo session (in transaction)
 * @param {Object}  params.existingUser                         User doc snapshot BEFORE the change
 * @param {Object}  params.newShopFull                          New shop doc (populated cityId)
 * @param {Object}  params.actor                                { telegramId, firstName, lastName, role }
 * @param {string}  params.reason                               history meta.reason
 * @param {boolean} [params.resetCartNavigation=false]          reset cartState navigation (lastViewedProductId, indices)
 * @param {boolean} [params.pushHistory=true]                   push history entry to user
 * @param {boolean} [params.updateLastSeller=true]              persist lastSeller snapshot on old shop
 */
async function migrateSellerShop({
  session,
  existingUser,
  newShopFull,
  actor,
  reason,
  resetCartNavigation = false,
  pushHistory = true,
  updateLastSeller = true,
  allowFrozenOrderTransfer = false,
  expectedOrderingSessionId = null,
}) {
  // This is the canonical CURRENT assignment command. Enforce both ends here,
  // not merely in the HTTP caller: every transport (admin route, transfer flow,
  // registration reactivation) gets identical role/shop invariants.
  assertAssignableShopRole(existingUser?.role, appError);
  const requestedShopId = newShopFull?._id ? String(newShopFull._id) : '';
  if (!requestedShopId) throw appError('shop_not_found');

  // Re-read the target inside the caller's transaction/session. A route-level
  // `isActive` check can become stale before the write; the command boundary is
  // the last authority before User.shopId changes.
  const freshTargetShop = await Shop.findById(requestedShopId)
    .populate('cityId', 'name')
    .session(session)
    .lean();
  assertOperationalShop(freshTargetShop, appError);
  newShopFull = freshTargetShop;

  const oldShopId = existingUser.shopId ? String(existingUser.shopId) : '';
  const newShopId = String(newShopFull._id);
  const newShopName = newShopFull.name || '';
  const newShopCity = newShopFull.cityId?.name || '';
  const newShopAddress = newShopFull.address || '';
  const newDeliveryGroupId = newShopFull.deliveryGroupId
    ? String(newShopFull.deliveryGroupId)
    : '';

  // Resolve authoritative topology for the old Shop inside this transaction.
  // Source Order discovery below is NOT derived from a session bucket; the old
  // DeliveryGroup is read only for topology/audit and for the explicit exact-
  // session conflict-repair precondition. Never use cached topology here.
  const oldShopFull = oldShopId
    ? await Shop.findById(oldShopId).populate('cityId', 'name').session(session).lean()
    : null;

  // Source Order discovery is intentionally SESSION-AGNOSTIC. CURRENT/NEXT is
  // destination routing only; using the old Shop's CURRENT session as a lookup key
  // made an Order legitimately routed to NEXT invisible on the seller's next move.
  // The only session-specific source precondition left here is the explicit
  // conflict-repair flow, which pins an exact CURRENT session chosen by staff.
  let oldGroup = null;
  if (oldShopFull?.deliveryGroupId) {
    oldGroup = await DeliveryGroup.findById(oldShopFull.deliveryGroupId).session(session).lean();
  }
  if (expectedOrderingSessionId) {
    if (!oldGroup) throw appError('ordering_session_changed');
    const currentOldSessionId = await findCurrentSessionId(
      String(oldGroup._id),
      oldGroup.orderingSchedule,
      { session },
    );
    if (String(currentOldSessionId || '') !== String(expectedOrderingSessionId)) {
      throw appError('ordering_session_changed');
    }
  }

  let targetSessionId = null;
  let routedToNextSession = false;
  let routeReason = 'no_order_move';
  const ownershipNow = new Date();

  // 1. Migrate active order FIRST so a downstream write failure aborts the whole tx
  let movedOrder = null;
  let shopOwnedOrder = null;
  // Assignment topology exists independently of whether an Order moves. Keep the
  // old group in the command result so post-commit publication can refresh
  // dashboards even for a seller with no active order.
  let prevGroupId = oldShopFull?.deliveryGroupId ? String(oldShopFull.deliveryGroupId) : null;

  if (oldShopId !== newShopId) {
    const resolution = await resolveSellerAssignmentOrder({
      seller: existingUser,
      session,
      now: ownershipNow,
      expectedOrderingSessionId,
      allowFrozenOverride: allowFrozenOrderTransfer,
    });

    const activeOrder = resolution.transferOrder;
    shopOwnedOrder = resolution.stayedOrder;

    if (activeOrder) {
      const ownership = resolution.transferOwnership;
      const destination = await resolveAssignmentDestination({
        shop: newShopFull,
        session,
        now: ownershipNow,
      });
      targetSessionId = destination.targetSessionId;
      routedToNextSession = destination.routedToNextSession;
      routeReason = destination.routeReason;

      await ensureOrderNotInPickingPipeline(activeOrder._id, session);

      activeOrder.shopId = newShopFull._id;
      if (!activeOrder.buyerSnapshot) activeOrder.buyerSnapshot = {};
      activeOrder.buyerSnapshot.shopId = newShopId;
      activeOrder.buyerSnapshot.shopName = newShopName;
      activeOrder.buyerSnapshot.shopCity = newShopCity;
      activeOrder.buyerSnapshot.shopAddress = newShopAddress;
      activeOrder.buyerSnapshot.deliveryGroupId = newDeliveryGroupId;
      activeOrder.orderingSessionId = targetSessionId;
      const restoredFromUnassign = activeOrder.status === ORDER_STATUS.NEW_UNASSIGN;
      if (restoredFromUnassign) activeOrder.status = ORDER_STATUS.NEW;
      activeOrder.markModified('buyerSnapshot');
      activeOrder.history.push({
        by: String(actor.telegramId),
        byName: [actor.firstName, actor.lastName].filter(Boolean).join(' '),
        byRole: actor.role,
        action: 'shop_reassigned',
        meta: {
          from: { shopName: oldShopFull?.name || '', deliveryGroupId: oldShopFull?.deliveryGroupId || '' },
          to:   { shopName: newShopName, shopCity: newShopCity, deliveryGroupId: newDeliveryGroupId },
          reason,
          routedToNextSession,
          routeReason,
          restoredFromUnassign,
          status: restoredFromUnassign ? ORDER_STATUS.NEW : activeOrder.status,
          ownershipRepair: Boolean(ownership?.frozen && allowFrozenOrderTransfer),
        },
      });
      await activeOrder.save({ session });
      movedOrder = activeOrder;

      await PickingTask.updateMany(
        { 'items.orderId': activeOrder._id, status: { $in: ['pending', 'locked'] } },
        { $set: { 'items.$[elem].shopName': newShopName } },
        { arrayFilters: [{ 'elem.orderId': activeOrder._id }], session },
      );
    }
  }

  // 2. Update User. Пишемо ТІЛЬКИ shopId: група доставки й назва зони читаються
  // з магазину (Shop.deliveryGroupId → DeliveryGroup.name) там, де потрібні.
  const userUpdate = {
    shopId: newShopFull._id,
  };

  if (resetCartNavigation) {
    userUpdate['cartState.lastViewedProductId'] = '';
    userUpdate['cartState.lastViewedOrderNumber'] = 0;
    userUpdate['cartState.currentIndex'] = 0;
    userUpdate['cartState.currentPage'] = 0;
    userUpdate['cartState.updatedAt'] = new Date();
  }

  const updatedUser = await User.findOneAndUpdate(
    { telegramId: existingUser.telegramId },
    { $set: userUpdate },
    { new: true, session },
  );

  // Transactional fail-closed guard: a mutable Order may never silently remain
  // on a different CURRENT Shop after User.shopId changes. Frozen/history Orders
  // are intentionally ignored by this invariant and may keep their old Shop.
  await assertSellerAssignmentOrderInvariant({
    sellerTelegramId: existingUser.telegramId,
    currentShopId: newShopId,
    session,
    now: ownershipNow,
  });

  // 3. Push history entry
  if (pushHistory && oldShopId !== newShopId) {
    await User.updateOne(
      { telegramId: existingUser.telegramId },
      {
        // Bounded timeline: keep only the most recent 20 entries. This is the
        // ONLY writer of User.history, and the user doc is loaded on EVERY
        // authed request (telegramAuth.findOne), so it must never grow without
        // limit. $slice trims from the front on each push.
        $push: {
          history: {
            $each: [{
              at: new Date(),
              by: String(actor.telegramId),
              byName: [actor.firstName, actor.lastName].filter(Boolean).join(' '),
              byRole: actor.role,
              action: 'shop_changed',
              meta: {
                fromShop: oldShopFull?.name || null,
                toShop: newShopName || null,
                reason,
                orderMoved: !!movedOrder,
                orderStayedWithShop: !!shopOwnedOrder,
              },
            }],
            $slice: -20,
          },
        },
      },
      { session },
    );
  }

  // 4. Persist last-seller snapshot on the OLD shop so the hint survives reassignment
  const now = new Date();
  if (updateLastSeller && oldShopId && oldShopId !== newShopId) {
    await Shop.findByIdAndUpdate(
      oldShopId,
      {
        lastSeller: {
          telegramId:   existingUser.telegramId,
          firstName:    existingUser.firstName  || '',
          lastName:     existingUser.lastName   || '',
          unassignedAt: now,
        },
        lastSellerChangedAt: now,
      },
      { session },
    );
  }

  // 5. Mark the new shop as recently changed
  if (newShopId && newShopId !== oldShopId) {
    await Shop.findByIdAndUpdate(
      newShopId,
      { $set: { lastSellerChangedAt: now } },
      { session },
    );
  }

  // Durable audit: record the transition + what happened to the active order.
  await logShopTransition(session, {
    actorTelegramId: String(actor?.telegramId || ''),
    actorName: [actor?.firstName, actor?.lastName].filter(Boolean).join(' '),
    actorRole: actor?.role || '',
    sellerTelegramId: String(existingUser.telegramId),
    sellerName: [existingUser.firstName, existingUser.lastName].filter(Boolean).join(' '),
    fromShopId: oldShopId,
    fromShopName: oldShopFull?.name || '',
    toShopId: newShopId,
    toShopName: newShopName,
    reason,
    source: 'migrate',
    orderAction: movedOrder ? 'moved' : (shopOwnedOrder ? 'stayed_with_shop' : 'none'),
    orderId: movedOrder ? String(movedOrder._id) : (shopOwnedOrder ? String(shopOwnedOrder._id) : ''),
    orderShopBefore: (movedOrder || shopOwnedOrder) ? oldShopId : '',
    orderShopAfter: movedOrder ? newShopId : (shopOwnedOrder ? oldShopId : ''),
    note: movedOrder ? `route=${routeReason}` : '',
  });

  // IMPORTANT: cache invalidation is intentionally NOT done here.
  // Doing it inside withTransaction would publish a stale-read window:
  // workers drop L1, read pre-commit state from the primary, and repopulate
  // the cache with the OLD value. The caller MUST call `invalidate()` from
  // the returned object AFTER session.withTransaction(...) resolves.
  return {
    updatedUser,
    movedOrder,
    shopOwnedOrder,
    fromShopId: oldShopId || null,
    toShopId: newShopId || null,
    sellerTelegramId: String(existingUser.telegramId),
    assignmentChanged: oldShopId !== newShopId,
    orderChanged: Boolean(movedOrder),
    prevGroupId,
    newGroupId: newDeliveryGroupId || null,
    invalidate: async () => {
      if (oldShopId) await invalidateShop(oldShopId);
      if (newShopId) await invalidateShop(newShopId);
    },
  };
}

module.exports = { migrateSellerShop };
