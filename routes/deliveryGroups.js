const express = require('express');
const mongoose = require('mongoose');
const { appError, asyncHandler } = require('../utils/errors');
const DeliveryGroup = require('../models/DeliveryGroup');
const Order = require('../models/Order');
const Shop = require('../models/Shop');
const PickingTask = require('../models/PickingTask');
const CatalogReview = require('../models/CatalogReview');
const OrderingSession = require('../models/OrderingSession');
const SupplementOffer = require('../models/SupplementOffer');
const { ACTIVE_ITEM_STATUSES, ITEM_RELATION_STATUS } = require('../utils/supplementState');
const { telegramAuth, requireTelegramRole, requireTelegramRoles } = require('../middleware/telegramAuth');
const {
  isOrderingOpen,
  getOrderingWindowBoundsForOpenDate,
  getOpenDateWarsaw,
  normalizeOrderingSchedule,
  validateOrderingScheduleDeliveryDay,
} = require('../utils/orderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { pushSessionEvent } = require('../utils/sessionStatus');
const { openItemArrayFilter } = require('../utils/orderItemState');
const { normalizeDeliveryGroup } = require('../utils/deliveryGroupHelpers');
const { shouldBlockUsedTargetSession } = require('../utils/deliveryGroupScheduleChange');
const { ACTIVE_ORDER_STATUSES } = require('../services/sessionPresentation');
const { getIO } = require('../socket');

const cache = require('../utils/cache');
const { invalidateDeliveryGroup } = require('../utils/modelCache');
const { buildSellerOrderingStatusReadModel } = require('../services/readModels/sellerOrderingStatusReadModel');
const { buildDeliveryGroupSummaryReadModel, buildDeliveryGroupListReadModel } = require('../services/readModels/deliveryGroupCatalogReadModel');
const { buildDeliveryGroupShopStatusReadModel } = require('../services/readModels/deliveryGroupShopStatusReadModel');
const { buildCurrentSessionShopProductsReadModel } = require('../services/readModels/currentSessionShopProductsReadModel');
const { buildDeliveryGroupSessionSummariesReadModel } = require('../services/readModels/deliveryGroupSessionSummaryReadModel');

const router = express.Router();

function addDaysToOpenDate(openDate, days) {
  const [year, month, day] = String(openDate).split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * GET /api/delivery-groups/ordering-status
 * Returns ordering window status for the current user's delivery group.
 * Admin/warehouse always get isOpen: true.
 */
router.get('/ordering-status', telegramAuth, asyncHandler(async (req, res) => {
  const payload = await buildSellerOrderingStatusReadModel(req.telegramUser);
  res.json(payload);
}));


/**
 * POST /api/delivery-groups/catalog-reviewed
 * The seller declares they walked the whole catalogue to the end in the CURRENT
 * ordering session. Informational only — nothing downstream gates on it; the
 * warehouse just wants to see who did and who didn't before picking starts.
 *
 * One-way and idempotent: the {sessionId, telegramId} unique index turns a second
 * press into a plain re-read, and there is no endpoint to clear the mark. It ages
 * out by itself when the next session starts (different sessionId).
 */
router.post('/catalog-reviewed', telegramAuth, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  if (!user.shopId) throw appError('no_shop');

  const shop = await Shop.findById(user.shopId).select('name deliveryGroupId isActive').lean();
  if (!shop) throw appError('shop_not_found');
  if (shop.isActive === false) throw appError('shop_inactive');
  if (!shop.deliveryGroupId) throw appError('group_not_found');

  const group = normalizeDeliveryGroup(await DeliveryGroup.findById(shop.deliveryGroupId).lean());
  if (!group) throw appError('group_not_found');

  const sessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);

  const productCount = Number(req.body?.productCount) || 0;
  const doc = {
    sessionId,
    groupId: String(group._id),
    telegramId: String(user.telegramId),
    userName: [user.firstName, user.lastName].filter(Boolean).join(' ') || String(user.telegramId),
    shopId: String(user.shopId),
    shopName: shop.name || '',
    at: new Date(),
    productCount,
  };

  // $setOnInsert only: re-pressing must NOT move the timestamp the warehouse
  // already saw on the board.
  const saved = await CatalogReview.findOneAndUpdate(
    { sessionId, telegramId: doc.telegramId },
    { $setOnInsert: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  // Nudge the picking board so the tick appears without waiting for a poll.
  try {
    const io = getIO();
    if (io) io.to(`picking_group_${String(group._id)}`).emit('shop_status_changed', { groupId: String(group._id) });
  } catch (e) {
  }

  res.json({ catalogReviewedAt: saved?.at || doc.at });
}));

router.get('/summary', asyncHandler(async (req, res) => {
  res.json(await buildDeliveryGroupSummaryReadModel());
}));


/**
 * GET /api/delivery-groups/:groupId/shop-status
 * Returns per-shop cart and ordered item counts for the current ordering session.
 */
router.get('/:groupId/shop-status', telegramAuth, requireTelegramRoles(['admin', 'warehouse']), asyncHandler(async (req, res) => {
  const payload = await buildDeliveryGroupShopStatusReadModel({
    groupId: req.params.groupId,
    view: req.query.view,
    viewerRole: req.telegramUser?.role || '',
  });
  res.json(payload);
}));


/**
 * GET /api/delivery-groups/:groupId/shops/:shopId/ordered-products
 * Lazy picking-board disclosure: return ONLY the distinct products currently
 * counted as ordered for this shop in the CURRENT ordering session.
 *
 * Intentionally separate from /shop-status so the normal board stays cheap:
 * product documents/photos are fetched only after staff expands one shop row.
 */
router.get('/:groupId/shops/:shopId/ordered-products', telegramAuth, requireTelegramRoles(['admin', 'warehouse']), asyncHandler(async (req, res) => {
  const payload = await buildCurrentSessionShopProductsReadModel({
    groupId: req.params.groupId,
    shopId: req.params.shopId,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json(payload);
}));


router.get('/session-summaries', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  res.json(await buildDeliveryGroupSessionSummariesReadModel());
}));


router.post('/:id/close-ordering-session', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id).lean();
  if (!group) throw appError('group_not_found');

  const admin = req.telegramUser || {};
  const adminActor = {
    by: String(admin.telegramId || ''),
    byName: [admin.firstName, admin.lastName].filter(Boolean).join(' '),
  };

  const status = isOrderingOpen(group.orderingSchedule);
  const currentSessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);

  // HARD RULE: once the warehouse has taken an order into the picking pipeline
  // (PickingTask pending/locked/completed) it is being physically packed. You
  // must NOT expire it just because the ordering session is being moved/closed —
  // that would silently lose a real, packed order. Exclude every such order.
  const pipelineTasks = await PickingTask.find(
    { status: { $in: ['pending', 'locked', 'completed'] } },
    'items.orderId',
  ).lean();
  const protectedOrderIds = [];
  for (const t of pipelineTasks) {
    for (const it of t.items || []) {
      if (it.orderId) protectedOrderIds.push(it.orderId);
    }
  }

  // This endpoint is a HISTORICAL cleanup tool, not a way to close today's
  // picking cycle. Old orders may be expired/parked, but the current session is
  // owned exclusively by its own closure lifecycle (coverage + picking tasks).
  // Therefore currentSessionId is ALWAYS excluded, regardless of whether the
  // ordering window is open or closed. This prevents an admin cleanup from
  // expiring a current coverage-gap order simply because it had no PickingTask yet.
  const staleOrderFilter = {
    'buyerSnapshot.deliveryGroupId': String(group._id),
    status: { $in: ['new', 'in_progress'] },
    orderingSessionId: { $ne: currentSessionId },
  };
  if (protectedOrderIds.length > 0) {
    staleOrderFilter._id = { $nin: protectedOrderIds };
  }

  // Transaction so a double-click / concurrent close cannot double-process.
  let expiredCount = 0;
  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      const expiredAt = new Date();
      const result = await Order.updateMany(
        staleOrderFilter,
        {
          $set: {
            status: 'expired',
            'items.$[open].voided': true,
            'items.$[open].voidReason': 'order_expired',
            'items.$[open].voidedAt': expiredAt,
          },
        },
        { session, arrayFilters: [openItemArrayFilter('open')] },
      );
      expiredCount = result.modifiedCount ?? result.nModified ?? 0;
    });
  } finally {
    session.endSession();
  }

  // Log "Закінчилась" on the session timeline — but only when the window for
  // THIS session is actually closing. If the admin clicks "close" while the
  // window is still open (intent = "just clean up stale orders from a previous
  // cycle"), we'd otherwise stamp the current cycle's session with a misleading
  // window-closed event even though its window remains open.
  if (!status.isOpen) {
    try {
      await pushSessionEvent(currentSessionId, {
        type: 'window_closed',
        ...adminActor,
        meta: { expiredCount },
      });
    } catch (e) {
    }
  }

  res.json({
    message: expiredCount > 0
      ? `Старі замовлення з попередньої сесії закрито: ${expiredCount}.`
      : 'Старих замовлень для закриття не знайдено.',
    expiredCount,
  });
}));

router.get('/', asyncHandler(async (req, res) => {
  res.json(await buildDeliveryGroupListReadModel());
}));


router.post('/', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { name, dayOfWeek, orderingSchedule } = req.body;
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || dayOfWeek === undefined || !orderingSchedule) {
    throw appError('group_name_or_day_required');
  }
  let normalizedSchedule;
  try { normalizedSchedule = validateOrderingScheduleDeliveryDay(orderingSchedule, dayOfWeek); }
  catch (err) { throw appError('group_schedule_invalid', { reason: err.message }); }

  const group = new DeliveryGroup({ name: trimmedName, dayOfWeek, orderingSchedule: normalizedSchedule });
  await group.save();
  await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
  await invalidateDeliveryGroup(group._id);
  res.status(201).json(group);
}));

router.patch('/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id);
  if (!group) throw appError('group_not_found');

  const admin = req.telegramUser || {};
  const adminActor = {
    by: String(admin.telegramId || ''),
    byName: [admin.firstName, admin.lastName].filter(Boolean).join(' '),
  };

  const { name, dayOfWeek, orderingSchedule } = req.body;
  const oldDayOfWeek = Number(group.dayOfWeek);
  const requestedDayOfWeek = dayOfWeek !== undefined ? Number(dayOfWeek) : oldDayOfWeek;
  const currentSchedule = normalizeOrderingSchedule(
    group.orderingSchedule?.toObject ? group.orderingSchedule.toObject() : group.orderingSchedule,
  );
  let requestedSchedule;
  try {
    requestedSchedule = validateOrderingScheduleDeliveryDay(
      orderingSchedule !== undefined ? orderingSchedule : currentSchedule,
      requestedDayOfWeek,
    );
  } catch (err) {
    throw appError('group_schedule_invalid', { reason: err.message });
  }
  const scheduleIsChanging = JSON.stringify(requestedSchedule) !== JSON.stringify(currentSchedule);
  const dayIsChanging = requestedDayOfWeek !== oldDayOfWeek;
  const timingIsChanging = dayIsChanging || scheduleIsChanging;

  let oldSessionId = null;
  let recordRescheduleOnSession = false;
  let emptyTargetSession = null;
  if (timingIsChanging) {
    const groupIdStr = String(group._id);
    const currentSessionId = await getOrCreateSessionId(groupIdStr, currentSchedule);
    const currentOpenDate = getOpenDateWarsaw(currentSchedule);
    const nextOpenDate = addDaysToOpenDate(currentOpenDate, 7);
    const nextSession = await OrderingSession.findOne(
      { groupId: groupIdStr, openDate: nextOpenDate },
      '_id pickingStatus openNotifiedAt',
    ).lean();
    const protectedSessionIds = [currentSessionId, nextSession?._id ? String(nextSession._id) : null].filter(Boolean);

    // Clock-time alone must not freeze an empty TEST/configuration group.
    // We block only when changing the calendar could strand REAL session data.
    const [sessionOrder, sessionTask, sessionSupplement, livePickingSession, currentSession] = await Promise.all([
      // Terminal history must NOT freeze schedule editing forever. Only orders
      // that can still change operationally are blockers.
      Order.exists({
        orderingSessionId: { $in: protectedSessionIds },
        status: { $in: ACTIVE_ORDER_STATUSES },
      }),
      // Same for tasks: completed tasks are history; only pending/locked work can
      // be stranded by a calendar change.
      PickingTask.exists({
        orderingSessionId: { $in: protectedSessionIds },
        status: { $in: ['pending', 'locked'] },
      }),
      SupplementOffer.exists({
        orderingSessionId: { $in: protectedSessionIds },
        waveId: { $ne: null },
        itemStatus: ITEM_RELATION_STATUS.ACTIVE,
        status: { $in: ACTIVE_ITEM_STATUSES },
      }),
      OrderingSession.exists({
        _id: { $in: protectedSessionIds },
        pickingStatus: { $in: ['confirmed', 'in_progress'] },
      }),
      OrderingSession.findById(currentSessionId, 'pickingStatus openNotifiedAt').lean(),
    ]);

    if (sessionOrder || sessionTask || sessionSupplement || livePickingSession) {
      const reason = sessionOrder ? 'у поточній або наступній сесії є активні замовлення'
        : sessionTask ? 'у поточній або наступній сесії є незавершені задачі збирання'
          : sessionSupplement ? 'у поточній або наступній сесії є активні позиції дозамовлення'
            : 'збирання поточної або наступної сесії вже підтверджене чи триває';
      throw appError('group_day_change_session_active', { reason });
    }

    // A different start weekday can point "current" at another calendar date.
    // Never let a schedule edit accidentally revive an old completed/used
    // OrderingSession as the new current session. Empty pending read-created
    // sessions are safe to discard and will be recreated with a fresh snapshot.
    const requestedOpenDate = getOpenDateWarsaw(requestedSchedule);
    const requestedWindowIsOpen = isOrderingOpen(requestedSchedule).isOpen;
    const requestedSession = await OrderingSession.findOne(
      { groupId: groupIdStr, openDate: requestedOpenDate },
      '_id pickingStatus openNotifiedAt',
    ).lean();
    if (requestedSession) {
      const requestedId = String(requestedSession._id);
      const [
        targetOrderCount,
        targetActiveOrder,
        targetTaskCount,
        targetOpenTask,
        targetSupplementCount,
        targetActiveSupplement,
      ] = await Promise.all([
        Order.countDocuments({ orderingSessionId: requestedId }),
        Order.exists({
          orderingSessionId: requestedId,
          status: { $in: ACTIVE_ORDER_STATUSES },
        }),
        PickingTask.countDocuments({ orderingSessionId: requestedId }),
        PickingTask.exists({
          orderingSessionId: requestedId,
          status: { $in: ['pending', 'locked'] },
        }),
        SupplementOffer.countDocuments({ orderingSessionId: requestedId, waveId: { $ne: null } }),
        SupplementOffer.exists({
          orderingSessionId: requestedId,
          waveId: { $ne: null },
          itemStatus: ITEM_RELATION_STATUS.ACTIVE,
          status: { $in: ACTIVE_ITEM_STATUSES },
        }),
      ]);
      const targetHasWork = targetOrderCount > 0
        || targetTaskCount > 0
        || targetSupplementCount > 0
        || requestedSession.pickingStatus !== 'pending';
      const targetHasLiveWork = Boolean(
        targetActiveOrder
        || targetOpenTask
        || targetActiveSupplement
        || ['confirmed', 'in_progress'].includes(requestedSession.pickingStatus)
      );
      const targetUsed = targetHasWork || Boolean(requestedSession.openNotifiedAt);

      if (shouldBlockUsedTargetSession({
        currentSessionId,
        requestedSessionId: requestedId,
        targetHasLiveWork,
        targetUsed,
        requestedWindowIsOpen,
      })) {
        throw appError('group_day_change_session_active', {
          reason: targetHasLiveWork
            ? `новий розклад потрапляє в сесію ${requestedOpenDate} з активною роботою`
            : `новий розклад повторно відкрив би вже використану сесію ${requestedOpenDate}`,
        });
      }

      // Never rewrite a used historical session, even while allowing a CLOSED
      // future configuration to reference its old openDate until the next
      // weekly start. Only a genuinely unused materialised shell is refreshable.
      if (!targetUsed) {
        emptyTargetSession = { id: requestedId, openDate: requestedOpenDate };
      }
    }

    // Do not reopen an already processed current cycle merely by moving the
    // close boundary forward. New settings then wait naturally for the next
    // weekly start instead of mixing new orders into completed picking.
    if (requestedWindowIsOpen && currentSession?.pickingStatus === 'completed') {
      throw appError('group_day_change_session_active', {
        reason: 'новий розклад повторно відкрив би вже завершену поточну сесію',
      });
    }

    oldSessionId = currentSessionId;
    // A timing edit after a COMPLETED cycle is future configuration; appending
    // `rescheduled` to that historical session would falsely rewrite its story.
    // Only an empty/pending current session is actually being rescheduled.
    recordRescheduleOnSession = currentSession?.pickingStatus === 'pending';
  }

  if (name !== undefined) {
    const trimmedName = String(name).trim();
    if (!trimmedName) throw appError('group_name_or_day_required');
    group.name = trimmedName;
  }
  if (dayOfWeek !== undefined) group.dayOfWeek = requestedDayOfWeek;
  if (orderingSchedule !== undefined || dayIsChanging) group.orderingSchedule = requestedSchedule;

  await group.save();

  if (emptyTargetSession) {
    const bounds = getOrderingWindowBoundsForOpenDate(emptyTargetSession.openDate, requestedSchedule);
    await OrderingSession.updateOne(
      { _id: emptyTargetSession.id, pickingStatus: 'pending' },
      {
        $set: {
          openAt: bounds.openAt,
          closeAt: bounds.closeAt,
          scheduleSnapshot: requestedSchedule,
        },
      },
    );
  }

  await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
  await invalidateDeliveryGroup(group._id);

  if (timingIsChanging && oldSessionId && recordRescheduleOnSession) {
    try {
      await pushSessionEvent(oldSessionId, {
        type: 'rescheduled',
        ...adminActor,
        meta: {
          fromDay: oldDayOfWeek,
          toDay: Number(group.dayOfWeek),
          fromSchedule: currentSchedule,
          toSchedule: requestedSchedule,
        },
      });
    } catch (e) {
    }
  }
  const persistedGroup = await DeliveryGroup.findById(group._id).lean();
  res.json(persistedGroup);
}));

router.delete('/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  // Check + delete in a single transaction so that a magazin or active order
  // created between the count and findByIdAndDelete cannot leave an orphan
  // reference behind.
  const session = await mongoose.connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const group = await DeliveryGroup.findById(req.params.id).session(session);
      if (!group) throw appError('group_not_found');

      const shopCount = await Shop.countDocuments({
        deliveryGroupId: String(group._id),
      }).session(session);
      if (shopCount > 0) throw appError('group_has_shops', { shopCount });

      const activeOrders = await Order.countDocuments({
        'buyerSnapshot.deliveryGroupId': String(group._id),
        status: { $in: ['new', 'in_progress'] },
      }).session(session);
      if (activeOrders > 0) throw appError('group_has_active_orders', { activeOrders });

      // Session history must never become an orphan. Read-only status screens can
      // materialise an EMPTY pending OrderingSession; those are safe to cascade
      // when the group itself is deleted. But once a session has any order/task,
      // catalogue-review mark, sequence number, notification, event or lifecycle
      // progress, it is history and the group deletion is blocked instead of
      // silently severing the reference.
      const groupSessions = await OrderingSession.find(
        { groupId: String(group._id) },
        '_id seq pickingStatus openNotifiedAt events',
      ).session(session).lean();
      const sessionIds = groupSessions.map((row) => String(row._id));
      if (sessionIds.length) {
        const [hasAnyOrder, hasAnyTask, hasAnyCatalogReview] = await Promise.all([
          Order.exists({ orderingSessionId: { $in: sessionIds } }).session(session),
          PickingTask.exists({ orderingSessionId: { $in: sessionIds } }).session(session),
          CatalogReview.exists({ sessionId: { $in: sessionIds } }).session(session),
        ]);
        const hasIntrinsicHistory = groupSessions.some((row) => (
          row.seq != null
          || row.pickingStatus !== 'pending'
          || Boolean(row.openNotifiedAt)
          || (Array.isArray(row.events) && row.events.length > 0)
        ));
        if (hasAnyOrder || hasAnyTask || hasAnyCatalogReview || hasIntrinsicHistory) {
          throw appError('group_has_history', { sessions: groupSessions.length });
        }

        await OrderingSession.deleteMany(
          { _id: { $in: groupSessions.map((row) => row._id) } },
          { session },
        );
      }

      await DeliveryGroup.deleteOne({ _id: group._id }, { session });
      result = { message: 'Групу видалено', _groupId: String(group._id) };
    });
    await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
    if (result?._groupId) {
      await invalidateDeliveryGroup(result._groupId);
      delete result._groupId;
    }
    return res.json(result);
  } finally {
    session.endSession();
  }
}));

/**
 * POST /api/delivery-groups/:id/broadcast
 * Send all active products to all members of the specified delivery group.
 */
/*
router.post('/:id/broadcast', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if (!group.members?.length) {
    return res.status(400).json({ error: 'Група не має учасників' });
  }

  try {
    const { startBroadcast } = require('../broadcast');
    const result = await startBroadcast({
      productFilter: { status: 'active' },
      recipientIds: group.members,
      addLabels: true,
    });
    res.json({ message: `Розсилку розпочато для групи "${group.name}"`, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
*/

module.exports = router;
