// Atomic helper: move seller (User) to a new shop, migrating their active order
// and any related PickingTask shopName references. All writes are scoped to the
// passed Mongo session so the caller can wrap the call in withTransaction().
//
// Returns: { updatedUser, movedOrder, prevGroupId, newGroupId }

const Shop = require('../models/Shop');
const User = require('../models/User');
const Order = require('../models/Order');
const DeliveryGroup = require('../models/DeliveryGroup');
const PickingTask = require('../models/PickingTask');
const OrderingSession = require('../models/OrderingSession');
const { getOrCreateSessionId, getOrCreateNextSessionId } = require('../utils/getOrCreateSession');
const { appError } = require('../utils/errors');
const { invalidateShop } = require('../utils/modelCache');
const { logShopTransition } = require('./shopAudit');
const { activeOrderShopFilter } = require('../utils/orderShopFilter');

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
}) {
  const oldShopId = existingUser.shopId ? String(existingUser.shopId) : '';
  const newShopId = String(newShopFull._id);
  const newShopName = newShopFull.name || '';
  const newShopCity = newShopFull.cityId?.name || '';
  const newDeliveryGroupId = newShopFull.deliveryGroupId
    ? String(newShopFull.deliveryGroupId)
    : '';

  // Resolve session ids and warehouse zone for both shops.
  // CRITICAL: read Shop + DeliveryGroup with the session, NOT from cache.
  // A stale cache here would compute the wrong oldSessionId and orphan the
  // active order in the previous group. Hot cache is fine for high-frequency
  // reads (buyerSnapshot, /me, bot) but not for the one-shot migration path.
  const oldShopFull = oldShopId
    ? await Shop.findById(oldShopId).populate('cityId', 'name').session(session).lean()
    : null;

  let oldSessionId = null;
  if (oldShopFull?.deliveryGroupId) {
    const oldGroup = await DeliveryGroup.findById(oldShopFull.deliveryGroupId).session(session).lean();
    if (oldGroup) {
      oldSessionId = await getOrCreateSessionId(String(oldGroup._id), oldGroup.orderingSchedule);
    }
  }

  // The migration moves ONLY the order from the old shop's CURRENT ordering
  // session (oldSessionId). Orders from EARLIER sessions are intentionally left
  // in place — see the lookup below.

  let newSessionId = null;
  let targetSessionId = null;
  let routedToNextSession = false;
  if (newDeliveryGroupId) {
    const newGroup = await DeliveryGroup.findById(newDeliveryGroupId).session(session).lean();
    if (newGroup) {
      newSessionId = await getOrCreateSessionId(String(newGroup._id), newGroup.orderingSchedule);
      targetSessionId = newSessionId;

      // If the destination group's CURRENT session is already being picked, an
      // order added now would never get a PickingTask: once pickingStatus leaves
      // 'pending', start-session stops building the plan entirely (routes/picking.js
      // returns `alreadyStarted` before the confirm branch), and lateOrderReconcile
      // can only ride an item along on a still-OPEN (pending) task. So park the
      // incoming order in the NEXT session — it is collected next cycle instead of
      // being stranded.
      //
      // The state is read straight off the session. The previous heuristic ("a task
      // references one of this session's orders") silently returned false for an
      // EMPTY session — it short-circuits on `currentSessionOrderIds.length > 0`. A
      // session the warehouse started with zero orders goes `confirmed` and then
      // immediately `completed` (picking_confirmed taskCount:0 → picking_completed
      // reason:'empty'), and an order moved into it died whole: every item `skipped`,
      // order `cancelled`. That is exactly how order #3 was lost on 06.08.2026.
      const targetSessionDoc = newSessionId
        ? await OrderingSession.findById(newSessionId, 'pickingStatus').session(session).lean()
        : null;
      const currentSessionInPicking = !!targetSessionDoc && targetSessionDoc.pickingStatus !== 'pending';

      if (currentSessionInPicking) {
        targetSessionId = await getOrCreateNextSessionId(String(newGroup._id), newGroup.orderingSchedule);
        routedToNextSession = true;
      }
    }
  }

  // 1. Migrate active order FIRST so a downstream write failure aborts the whole tx
  let movedOrder = null;
  let prevGroupId = null;

  if (oldShopId !== newShopId) {
    let activeOrder = null;

    if (oldShopId) {
      const legacyOrderQuery = activeOrderShopFilter(existingUser.shopId, {
        buyerTelegramId: existingUser.telegramId,
      });

      // Move ONLY the seller's order from the CURRENT ordering session of the old
      // shop. A stale order from an EARLIER session is deliberately NOT moved:
      // silently yanking it into the new shop's session (the removed fallback)
      // dropped it into a picking run it never belonged to and re-sessioned it
      // behind the operator's back. Stale orders surface separately via picking
      // start-session's `staleWarnings` for explicit manual handling.
      if (oldSessionId) {
        activeOrder = await Order.findOne({
          ...legacyOrderQuery,
          orderingSessionId: oldSessionId,
        }).session(session);
      }
    } else {
      // Seller can be temporarily unassigned. In that case pick a parked active
      // order (no shop attached) and move it into the newly assigned shop.
      activeOrder = await Order.findOne({
        buyerTelegramId: existingUser.telegramId,
        status: { $in: ['new', 'in_progress'] },
        $or: [
          { shopId: null },
          { 'buyerSnapshot.shopId': null },
          { 'buyerSnapshot.shopId': { $exists: false } },
        ],
      }).sort({ updatedAt: -1, createdAt: -1 }).session(session);
    }

    if (activeOrder) {
      await ensureOrderNotInPickingPipeline(activeOrder._id, session);

      prevGroupId = activeOrder.buyerSnapshot?.deliveryGroupId
        ? String(activeOrder.buyerSnapshot.deliveryGroupId)
        : null;

      activeOrder.shopId = newShopFull._id;
      if (!activeOrder.buyerSnapshot) activeOrder.buyerSnapshot = {};
      activeOrder.buyerSnapshot.shopId = newShopId;
      activeOrder.buyerSnapshot.shopName = newShopName;
      activeOrder.buyerSnapshot.shopCity = newShopCity;
      activeOrder.buyerSnapshot.deliveryGroupId = newDeliveryGroupId;
      if (targetSessionId) activeOrder.orderingSessionId = targetSessionId;
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
          // True when the destination's current session was already being picked,
          // so this order was parked in the NEXT session (collected next cycle).
          routedToNextSession,
        },
      });
      await activeOrder.save({ session });
      movedOrder = activeOrder;

      // Sync shopName in any active PickingTask items referencing this order.
      // NB: failure here MUST abort the transaction — picking workers would otherwise
      // see a stale shop name on items they're packing.
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

  // 3. Push history entry
  if (pushHistory && oldShopId !== newShopId) {
    await User.updateOne(
      { telegramId: existingUser.telegramId },
      {
        // Bounded timeline: keep only the most recent 20 entries. This is the
        // ONLY writer of User.history, and the user doc is loaded on EVERY
        // authed request (telegramAuth.findOne) — plus /ordering-status reads
        // this array to surface the "вас переміщено" note — so it must never
        // grow without limit. $slice trims from the front on each push.
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
    orderAction: movedOrder ? 'moved' : 'none',
    orderId: movedOrder ? String(movedOrder._id) : '',
    orderShopBefore: movedOrder ? oldShopId : '',
    orderShopAfter: movedOrder ? newShopId : '',
  });

  // IMPORTANT: cache invalidation is intentionally NOT done here.
  // Doing it inside withTransaction would publish a stale-read window:
  // workers drop L1, read pre-commit state from the primary, and repopulate
  // the cache with the OLD value. The caller MUST call `invalidate()` from
  // the returned object AFTER session.withTransaction(...) resolves.
  return {
    updatedUser,
    movedOrder,
    prevGroupId,
    newGroupId: newDeliveryGroupId || null,
    invalidate: async () => {
      if (oldShopId) await invalidateShop(oldShopId);
      if (newShopId) await invalidateShop(newShopId);
    },
  };
}

module.exports = { migrateSellerShop };
