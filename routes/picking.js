const express = require('express');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Block = require('../models/Block');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const User = require('../models/User');
const Shop = require('../models/Shop');
const CatalogReview = require('../models/CatalogReview');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { getProductTitle } = require('../services/archiveProduct');
const { buildPickingTasksFromOrders } = require('../services/taskBuilder');
const { auditSessionCoverage, resolveCoverageGap } = require('../services/sessionCoverage');
const { auditSessionClosure } = require('../services/sessionClosure');
const { isOrderingOpen, getOrderingWindowCloseAt, getOrderingWindowOpenAt, getNextOrderingWindowOpenAt, getOpenDateWarsaw, getPickingReadiness } = require('../utils/orderingSchedule');
const { getOrCreateSessionId, findCurrentSessionId } = require('../utils/getOrCreateSession');
const { ensureSessionSeq } = require('../utils/sessionSeq');
const { normalizeDeliveryGroup } = require('../utils/deliveryGroupHelpers');
const { appError, asyncHandler } = require('../utils/errors');
const { withLock } = require('../utils/lock');
const { transitionPickingStatus, maybeCompleteSession } = require('../utils/sessionStatus');
const { getSessionVocab } = require('../utils/sessionVocab');
const { computeSessionPhase, buildSessionSummary, deriveSessionPresentationMode } = require('../services/sessionPresentation');
const { reconcileLateOrdersForSession } = require('../services/lateOrderReconcile');
const { ensureSessionShopNumbers, buildShopNumberLookup } = require('../utils/shopNumbering');
const SupplementOffer   = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
// New SupplementWave rows are scoped to the exact current OrderingSession;
// legacy waveId=null rows remain group-scoped only for compatibility.
const { countActiveOffersForGroup } = require('../services/supplementOffers');
const { getSupplementShiftSummary, getSupplementWorkerHistory } = require('../services/readModels/supplementShiftActivityReadModel');
const { getTelegramUsernameMap } = require('../utils/telegramUsername');

const {
  findAndLockNext,
  releaseWorkerAndStaleLocks,
  completePickingTask,
  outOfStockPickingTask,
  forceClaimPickingTask,
  reconcileActiveTasksForSession,
  archiveOrphanedOutOfStockProducts,
  releaseOtherLocksOfWorker,
  releasePickingTask,
  markSessionInProgress,
  FORCE_CLAIM_AFTER_MS,
  LOCK_TIMEOUT_MS,
} = require('../services/pickingService');

/** Session-timeline actor built from the authenticated Telegram user. */
function actorOf(user) {
  return {
    by: String(user?.telegramId || ''),
    byName: [user?.firstName, user?.lastName].filter(Boolean).join(' '),
  };
}

const router = express.Router();

// A transient transaction conflict that survived the service's internal retries
// (contention on the same task/product). Pass it through to the central handler,
// which answers 409 "try again" — never a 500.
function isTransientTx(err) {
  const labels = Array.isArray(err?.errorLabels) ? err.errorLabels : [];
  return !!err && (err.code === 112 || err.codeName === 'WriteConflict'
    || labels.includes('TransientTransactionError')
    || (typeof err.hasErrorLabel === 'function' && err.hasErrorLabel('TransientTransactionError')));
}

// ---------------------------------------------------------------------------
// Local helpers (route-layer only — not business logic)
// ---------------------------------------------------------------------------

// Distinct products ordered in a group's CURRENT ordering session (active orders).
// Counts product "positions" (one per productId, matching task granularity), not
// units. Read-only: resolves the session via getOpenDateWarsaw + a findOne (no
// upsert) so a polling GET never mutates. Best-effort — returns 0 on any failure.
async function countOrderedPositions(deliveryGroupId) {
  try {
    const group = await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek orderingSchedule').lean();
    if (!group) return 0;
    const openDate = getOpenDateWarsaw(group.orderingSchedule);
    const session = await OrderingSession.findOne(
      { groupId: String(deliveryGroupId), openDate },
      '_id',
    ).lean();
    if (!session) return 0;
    const orders = await Order.find(
      {
        'buyerSnapshot.deliveryGroupId': String(deliveryGroupId),
        status: { $in: ['new', 'in_progress'] },
        orderingSessionId: String(session._id),
      },
      'items.productId items.packed items.cancelled items.skipped items.voided',
    ).lean();
    const products = new Set();
    for (const o of orders) {
      for (const it of o.items || []) {
        if (it.packed || it.cancelled || it.skipped || it.voided || !it.productId) continue;
        products.add(String(it.productId));
      }
    }
    return products.size;
  } catch (err) {
    return 0;
  }
}

// Resolve the CURRENT ordering session for operational picking reads. Old sessions
// are deliberately never used as fallback: their tasks/orders are history/repair
// data and must not leak into the live warehouse queue.
async function resolveCurrentPickingSession(deliveryGroupId) {
  const groupId = String(deliveryGroupId || '');
  if (!groupId) return { group: null, sessionId: null, schedule: null };
  const group = await DeliveryGroup.findById(groupId, 'dayOfWeek name orderingSchedule').lean();
  if (!group) return { group: null, sessionId: null, schedule: null };
  const sessionId = await findCurrentSessionId(groupId, group.orderingSchedule);
  return { group, sessionId, schedule: group.orderingSchedule };
}

/**
 * Pure presentation snapshot for a selected delivery group.
 *
 * IMPORTANT: this function is a READ boundary. It must never materialise an
 * OrderingSession, release/claim locks, reconcile tasks/orders, archive products
 * or repair historical rows. Browser navigation may call it freely.
 */
async function buildReadOnlyPickingSessionSnapshot(deliveryGroupId, { now = new Date() } = {}) {
  const groupId = String(deliveryGroupId || '');
  if (!groupId) throw appError('picking_delivery_group_required');

  const group = normalizeDeliveryGroup(await DeliveryGroup.findById(
    groupId,
    'dayOfWeek name orderingSchedule',
  ).lean());
  if (!group) throw appError('group_not_found');

  const windowState = isOrderingOpen(group.orderingSchedule, now);
  const nextOrderingOpenAt = getNextOrderingWindowOpenAt(group.orderingSchedule, now);
  const readiness = getPickingReadiness(group.orderingSchedule, now);
  const readinessEnvelope = {
    serverNow: readiness.serverNow.toISOString(),
    pickingReadyAt: readiness.pickingReadyAt.toISOString(),
    pickingReady: readiness.pickingReady,
    pickingReadyInMs: readiness.pickingReadyInMs,
  };
  const sessionId = await findCurrentSessionId(groupId, group.orderingSchedule);
  const supplementCount = await countActiveOffersForGroup(groupId, { orderingSessionId: sessionId });

  if (windowState.isOpen) {
    return {
      windowOpen: true,
      message: windowState.message || '',
      windowCloseAt: getOrderingWindowCloseAt(group.orderingSchedule, now).toISOString(),
      pickingStatus: null,
      phase: 'ordering_open',
      presentationMode: 'ordering_open',
      nextOrderingOpenAt: nextOrderingOpenAt.toISOString(),
      sessionSummary: null,
      groupDayOfWeek: group.dayOfWeek,
      events: [],
      vocab: getSessionVocab(),
      supplementCount,
      ...readinessEnvelope,
    };
  }

  const session = sessionId
    ? await OrderingSession.findById(sessionId, 'pickingStatus events seq openDate finalSummary').lean()
    : null;
  const pickingStatus = session?.pickingStatus || null;
  const phase = sessionId
    ? await computeSessionPhase({
      deliveryGroupId: groupId,
      sessionId,
      pickingStatus: pickingStatus || 'pending',
      orderingSchedule: group.orderingSchedule,
    })
    : 'idle';
  const presentationMode = deriveSessionPresentationMode({
    phase,
    nextOrderingOpenAt,
    now,
  });
  const sessionSummary = await buildSessionSummary(phase, {
    deliveryGroupId: groupId,
    sessionId,
    session,
  });
  const baseEnvelope = {
    pickingStatus,
    phase,
    presentationMode,
    nextOrderingOpenAt: nextOrderingOpenAt.toISOString(),
    sessionSummary,
    groupDayOfWeek: group.dayOfWeek,
    events: (session?.events || []).slice(-10),
    vocab: getSessionVocab(),
    supplementCount,
    ...readinessEnvelope,
  };

  if (presentationMode === 'upcoming_preflight') {
    return {
      upcomingPreflight: true,
      ...baseEnvelope,
    };
  }

  if (session && session.pickingStatus !== 'pending') {
    const pendingCount = await PickingTask.countDocuments({ orderingSessionId: sessionId, status: 'pending' });
    return {
      alreadyStarted: true,
      taskCount: pendingCount,
      sessionActive: session.pickingStatus === 'in_progress',
      sessionConfirmed: true,
      ...baseEnvelope,
    };
  }

  return { preStart: true, ...baseEnvelope };
}

async function buildTaskResponse(task, { isSecondChance = false } = {}) {
  if (!task) return null;
  const product = await Product.findById(task.productId).lean();
  if (!product) return null;

  const imageUrl =
    (Array.isArray(product.imageUrls) && product.imageUrls[0]) ||
    product.localImageUrl ||
    null;

  // Resolve this session's frozen box numbers so each shop shows the SAME number
  // across every product (staff label boxes by digit). By shopId, falling back to
  // shopName for older tasks that predate the item.shopId field.
  let shopLookup = { byId: new Map(), byName: new Map() };
  if (task.orderingSessionId) {
    const sess = await OrderingSession.findById(task.orderingSessionId, 'shopNumbers').lean();
    shopLookup = buildShopNumberLookup(sess?.shopNumbers);
  }
  const boxNumberFor = (item) =>
    (item.shopId != null ? shopLookup.byId.get(String(item.shopId)) : undefined) ??
    shopLookup.byName.get(String(item.shopName || '')) ??
    null;

  return {
    taskId: String(task._id),
    productId: String(product._id),
    productTitle: getProductTitle(product),
    imageUrl,
    blockId: task.blockId,
    positionIndex: task.positionIndex,
    status: task.status,
    lockedBy: task.lockedBy,
    isSecondChance,
    items: (task.items || [])
      .map((item) => ({
        orderId: String(item.orderId),
        shopName: item.shopName || '',
        shopNumber: boxNumberFor(item),
        sellerName: item.sellerName || '',
        orderCreatedAt: item.orderCreatedAt || null,
        quantity: item.quantity,
        packedQuantity: item.packedQuantity ?? null,
        packed: item.packed,
        packedBy: item.packedBy || null,
        packedByName: item.packedByName || '',
        packedAt: item.packedAt || null,
      }))
      // Sort by the stable box number so the packing list order matches the digits
      // on the boxes. Items without a resolved number (edge/fallback) sink to the
      // bottom, then by creation time as a tiebreaker.
      .sort((a, b) =>
        (a.shopNumber ?? Infinity) - (b.shopNumber ?? Infinity)
        || new Date(a.orderCreatedAt || 0) - new Date(b.orderCreatedAt || 0)),
  };
}

/**
 * Keep active tasks aligned with one ordering session.
 * Removes task items that belong to orders outside the target session and
 * drops empty active tasks so old sessions cannot block a new picking start.
 */

// ---------------------------------------------------------------------------
// GET /api/picking/session-status?groupId=...
// Lightweight: returns only pickingStatus for the current session of a group.
// Used by the seller catalog to hide "ordered" badge once picking has started.
// ---------------------------------------------------------------------------
router.get('/session-status', requireTelegramRoles(['warehouse', 'admin', 'seller']), asyncHandler(async (req, res) => {
  const { groupId } = req.query;
  if (!groupId) return res.json({ pickingStatus: 'pending' });
  const group = await DeliveryGroup.findById(groupId, 'dayOfWeek orderingSchedule').lean();
  if (!group) return res.json({ pickingStatus: 'pending' });
  const sessionId = await findCurrentSessionId(String(groupId), group.orderingSchedule);
  if (!sessionId) return res.json({ pickingStatus: 'pending' });
  const session = await OrderingSession.findById(sessionId, 'pickingStatus').lean();
  res.json({ pickingStatus: session?.pickingStatus || 'pending' });
}));

// ---------------------------------------------------------------------------
// GET /api/picking/schedule
// Returns current ordering schedule used for picking gate UI.
// ---------------------------------------------------------------------------
router.get('/schedule', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const groupId = String(req.query.groupId || '');
    if (!groupId) return next(appError('picking_delivery_group_required'));
    const group = await DeliveryGroup.findById(groupId, 'orderingSchedule').lean();
    if (!group) return next(appError('group_not_found'));
    res.json(group.orderingSchedule);
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_session_failed'));
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/session-snapshot?deliveryGroupId=...
// Pure read used when opening/switching delivery groups. It is intentionally
// separate from the start command so navigation can never create a session.
// ---------------------------------------------------------------------------
router.get('/session-snapshot', requireTelegramRoles(['warehouse', 'admin']), asyncHandler(async (req, res) => {
  const snapshot = await buildReadOnlyPickingSessionSnapshot(req.query.deliveryGroupId || null);
  res.json(snapshot);
}));

// ---------------------------------------------------------------------------
// POST /api/picking/start-session
// Body: { deliveryGroupId, confirm? }
//
// Detection is SESSION-SCOPED: every decision is derived from the
// OrderingSession document (pickingStatus + events) plus tasks filtered by
// orderingSessionId. There is no `updatedAt >= sessionOpenAt` heuristic and no
// DeliveryGroup.pickingConfirmedAt — both were the source of the cross-session
// leak that stranded late orders when the admin changed the delivery day.
// ---------------------------------------------------------------------------
router.post('/start-session', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const { deliveryGroupId = null, confirm = false } = req.body;
    if (!deliveryGroupId) {
      return next(appError('picking_delivery_group_required'));
    }

    // Backward compatibility for an older client that POSTed start-session as a
    // read probe. confirm=false is now guaranteed read-only; the current client
    // uses GET /session-snapshot and only POSTs here for an explicit Start action.
    if (!confirm) {
      return res.json(await buildReadOnlyPickingSessionSnapshot(deliveryGroupId));
    }

    const actor = {
      by: String(user.telegramId || ''),
      byName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    };

    // 1. Ordering window — picking blocked while sellers can still place orders.
    const group = normalizeDeliveryGroup(await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek name orderingSchedule').lean());
    if (!group) throw appError('group_not_found');

    const commandNow = new Date();
    const { isOpen, message } = isOrderingOpen(group.orderingSchedule, commandNow);
    const readiness = getPickingReadiness(group.orderingSchedule, commandNow);
    const readinessEnvelope = {
      serverNow: readiness.serverNow.toISOString(),
      pickingReadyAt: readiness.pickingReadyAt.toISOString(),
      pickingReady: readiness.pickingReady,
      pickingReadyInMs: readiness.pickingReadyInMs,
    };
    if (isOpen) {
      const windowCloseAt = getOrderingWindowCloseAt(group.orderingSchedule, commandNow).toISOString();
      return res.json({ windowOpen: true, message, windowCloseAt, ...readinessEnvelope });
    }
    // The one-minute close→picking gap is enforced HERE, before any lock cleanup,
    // session materialisation, archive/reconcile or task mutation. A stale/buggy
    // client cannot bypass the server by POSTing confirm:true at 07:30:01.
    if (!readiness.pickingReady) {
      return res.json({
        pickingNotReady: true,
        message: 'Збирання ще не готове до старту.',
        ...readinessEnvelope,
      });
    }
    // Window closed and picking-ready. Before touching any operational state, resolve the
    // PRESENTATION read-only. During the final 24h before the next ordering
    // window, a terminal previous cycle (completed OR empty/idle) must show the
    // same readiness board. This check deliberately happens before
    // getOrCreateSessionId/releaseWorkerAndStaleLocks so merely opening the page
    // cannot create/mutate a session while we are only preparing the next cycle.
    const nextOrderingOpenAt = getNextOrderingWindowOpenAt(group.orderingSchedule);
    const existingSessionId = await findCurrentSessionId(String(deliveryGroupId), group.orderingSchedule);
    const existingSession = existingSessionId
      ? await OrderingSession.findById(existingSessionId, 'pickingStatus events seq openDate finalSummary').lean()
      : null;
    const existingPickingStatus = existingSession?.pickingStatus || 'pending';
    const existingPhase = existingSessionId
      ? await computeSessionPhase({
        deliveryGroupId,
        sessionId: existingSessionId,
        pickingStatus: existingPickingStatus,
        orderingSchedule: group.orderingSchedule,
      })
      : 'idle';
    const presentationMode = deriveSessionPresentationMode({
      phase: existingPhase,
      nextOrderingOpenAt,
    });

    if (presentationMode === 'upcoming_preflight') {
      const supplementCount = await countActiveOffersForGroup(deliveryGroupId, { orderingSessionId: existingSessionId });
      return res.json({
        upcomingPreflight: true,
        presentationMode,
        nextOrderingOpenAt: nextOrderingOpenAt.toISOString(),
        pickingStatus: existingSession?.pickingStatus || null,
        phase: existingPhase,
        sessionSummary: await buildSessionSummary(existingPhase, {
          deliveryGroupId,
          sessionId: existingSessionId,
          session: existingSession,
        }),
        groupDayOfWeek: group.dayOfWeek,
        events: (existingSession?.events || []).slice(-10),
        vocab: getSessionVocab(),
        supplementCount,
      });
    }

    // Outside the presentation-only preflight, picking is allowed for the whole
    // dead-time until the next window opens; session identity stays the same.

    // 2. Resolve session, free this worker's stale locks, archive orphans,
    //    drop tasks whose orders no longer belong to the current session.
    // releaseOwnLocks:false — a worker re-opening the picking page (which re-runs
    // start-session on mount) must NOT lose their active pick. Genuinely abandoned
    // own locks are still swept by the >LOCK_TIMEOUT_MS age condition. Same guard as
    // block-tasks / queue-stats already use.
    await releaseWorkerAndStaleLocks(user.telegramId, deliveryGroupId, { releaseOwnLocks: false });
    const currentSessionId = await getOrCreateSessionId(String(deliveryGroupId), group.orderingSchedule);
    await archiveOrphanedOutOfStockProducts(deliveryGroupId, currentSessionId);
    await reconcileActiveTasksForSession(deliveryGroupId, currentSessionId);

    // 3. STRICT late-order reconciliation. Picking is a frozen snapshot once
    //    started — an order that arrived/changed afterwards can only RIDE ALONG on
    //    a product that still has an open (pending) task; otherwise its items are
    //    marked `skipped` (the warehouse never walks back). We never create a new
    //    task here, so a completed session is NOT reopened — latecomers to a
    //    finished session are simply skipped. See services/lateOrderReconcile.js.
    let session = await OrderingSession.findById(currentSessionId).lean();
    if (session && session.pickingStatus !== 'pending') {
      await reconcileLateOrdersForSession(deliveryGroupId, currentSessionId);
      session = await OrderingSession.findById(currentSessionId).lean();
    }

    const sessionActiveCount = await PickingTask.countDocuments({
      orderingSessionId: currentSessionId,
      status: { $in: ['pending', 'locked'] },
    });
    const sessionPendingCount = await PickingTask.countDocuments({
      orderingSessionId: currentSessionId,
      status: 'pending',
    });

    const recentEvents = (session?.events || []).slice(-10);
    // Window is closed here (the isOpen branch returned above), so phase derives
    // from pickingStatus + whether the session has real work.
    const basePhase = await computeSessionPhase({
      deliveryGroupId,
      sessionId: currentSessionId,
      pickingStatus: session?.pickingStatus || 'pending',
      orderingSchedule: group.orderingSchedule,
    });
    const baseSummary = await buildSessionSummary(basePhase, {
      deliveryGroupId, sessionId: currentSessionId, session,
    });
    // vocab travels with the events so the UI never hardcodes status/event
    // labels — backend stays the single source of truth for the enum + labels.
    // Payload is ~500 bytes and start-session is not a hot path.
    // Активні дозамовлення — окремий канал роботи поза PickingTask. UI мусить
    // знати про них навіть коли звичайних задач нуль, інакше віртуальний блок
    // «Дозамовлення» стане недосяжним (кнопка «Показати замовлення» ховається
    // на екрані «все зібрано»).
    const supplementCount = await countActiveOffersForGroup(deliveryGroupId, { orderingSessionId: currentSessionId });

    const baseEnvelope = {
      pickingStatus: session?.pickingStatus || 'pending',
      phase: basePhase,
      presentationMode: basePhase,
      nextOrderingOpenAt: nextOrderingOpenAt.toISOString(),
      sessionSummary: baseSummary,
      groupDayOfWeek: group.dayOfWeek,
      events: recentEvents,
      vocab: getSessionVocab(),
      supplementCount,
    };

    // 4. Branch on session status. Frontend keeps its existing envelope keys
    //    (windowOpen / preStart / alreadyStarted / started / noOrders / unresolved)
    //    so usePickingSession does not have to change.
    if (session && session.pickingStatus !== 'pending') {
      // Already confirmed at some point — never show pre_start again.
      return res.json({
        alreadyStarted: true,
        taskCount: sessionPendingCount,
        sessionActive: session.pickingStatus === 'in_progress',
        sessionConfirmed: true,
        ...baseEnvelope,
      });
    }

    // 5. Confirm flow — block on unresolved cross-seller conflicts.
    const sessionActiveOrders = await Order.find(
      {
        'buyerSnapshot.deliveryGroupId': String(deliveryGroupId),
        status: { $in: ['new', 'in_progress'] },
        orderingSessionId: currentSessionId,
      },
      '_id shopId buyerSnapshot buyerTelegramId orderNumber',
    ).lean();

    const ordersByShop = new Map();
    for (const o of sessionActiveOrders) {
      const sid = String(o.shopId || o.buyerSnapshot?.shopId || '');
      if (!sid) continue;
      if (!ordersByShop.has(sid)) ordersByShop.set(sid, []);
      ordersByShop.get(sid).push(o);
    }
    const conflictShopIds = [...ordersByShop.entries()]
      .filter(([, orders]) => new Set(orders.map((o) => String(o.buyerTelegramId))).size > 1)
      .map(([sid]) => sid);

    if (conflictShopIds.length > 0) {
      const conflicts = [];
      for (const sid of conflictShopIds) {
        for (const o of ordersByShop.get(sid)) {
          conflicts.push({
            orderId: String(o._id),
            orderNumber: o.orderNumber,
            shopName: o.buyerSnapshot?.shopName || '—',
            shopCity: o.buyerSnapshot?.shopCity || '',
          });
        }
      }
      return res.json({ unresolved: true, conflicts, ...baseEnvelope });
    }

    // Safety-net numbering: any path that moved/created an Order in this session
    // must result in a visible seq before warehouse confirmation. Normal MiniApp
    // ordering assigns it earlier, but this heals admin/migration edge paths too.
    if (sessionActiveOrders.length > 0) {
      try {
        await ensureSessionSeq(currentSessionId, String(deliveryGroupId));
        session = await OrderingSession.findById(currentSessionId).lean();
      } catch (e) {
      }
    }

    // 6. Stale-order warnings (informational; don't block start).
    const staleOrders = await Order.find(
      {
        'buyerSnapshot.deliveryGroupId': String(deliveryGroupId),
        status: { $in: ['new', 'in_progress'] },
        orderingSessionId: { $ne: currentSessionId },
      },
      'buyerSnapshot buyerTelegramId orderingSessionId',
    ).lean();
    const staleWarnings = staleOrders.map((o) => ({
      orderId: String(o._id),
      shopName: o.buyerSnapshot?.shopName || '—',
      shopCity: o.buyerSnapshot?.shopCity || '',
      buyerTelegramId: String(o.buyerTelegramId),
    }));

    // Заморожуємо номери коробок. Активні дозамовлення додають магазини без
    // основного Order; пізніші магазини отримують номер у хвіст.
    const activeOffers = await SupplementOffer.find(
      { deliveryGroupId: String(deliveryGroupId), status: { $in: SupplementOffer.ACTIVE_STATUSES } },
      '_id',
    ).lean();
    const supplementShops = activeOffers.length
      ? await SupplementRequest.find(
        { offerId: { $in: activeOffers.map((o) => o._id) } },
        'shopId shopName',
      ).lean()
      : [];
    await ensureSessionShopNumbers(currentSessionId, [...sessionActiveOrders, ...supplementShops]);

    // 8. Build tasks, then move pending → confirmed.
    await buildPickingTasksFromOrders(deliveryGroupId, { orderingSessionId: currentSessionId });

    // 8a. Coverage audit — every live order item must now be represented by a
    // task. taskBuilder skips silently (no block position, archived product,
    // swallowed insertMany error), so without this check the session would start
    // missing goods that nobody would ever see again. Blocks the start exactly
    // like an unresolved seller conflict does.
    const coverage = await auditSessionCoverage({
      deliveryGroupId,
      orderingSessionId: currentSessionId,
    });
    if (!coverage.ok) {
      return res.json({ coverageGaps: true, gaps: coverage.gaps, ...baseEnvelope });
    }

    const builtCount = await PickingTask.countDocuments({
      orderingSessionId: currentSessionId,
      status: 'pending',
    });

    const confirmed = await transitionPickingStatus(currentSessionId, 'confirmed', {
      actor, meta: { taskCount: builtCount },
    });
    const confirmedDoc = confirmed ? (confirmed.toObject ? confirmed.toObject() : confirmed) : null;

    // Порожня сесія визначається лише за звичайними PickingTask.
    // Дозамовлення має незалежний цикл: docs/supplement/readme.md.
    if (builtCount === 0) {
      // Empty session — close it out immediately so reloads see noOrders.
      const completed = await maybeCompleteSession(currentSessionId, {
        actor, meta: { reason: 'empty' },
      });
      const finalDoc = completed
        ? (completed.toObject ? completed.toObject() : completed)
        : confirmedDoc;
      return res.json({
        noOrders: true,
        staleWarnings,
        pickingStatus: finalDoc?.pickingStatus || 'completed',
        phase: await computeSessionPhase({
          deliveryGroupId,
          sessionId: currentSessionId,
          pickingStatus: finalDoc?.pickingStatus || 'completed',
          orderingSchedule: group.orderingSchedule,
        }),
        events: (finalDoc?.events || []).slice(-10),
        vocab: getSessionVocab(),
        // Справжній лічильник, а не нуль: «звичайних замовлень немає» і «немає
        // дозамовлень» — різні речі, і клієнт малює кнопку віртуального блока
        // саме за цим числом.
        supplementCount,
      });
    }

    return res.json({
      started: true,
      taskCount: builtCount,
      staleWarnings,
      pickingStatus: confirmedDoc?.pickingStatus || 'confirmed',
      phase: await computeSessionPhase({
        deliveryGroupId,
        sessionId: currentSessionId,
        pickingStatus: confirmedDoc?.pickingStatus || 'confirmed',
        orderingSchedule: group.orderingSchedule,
      }),
      events: (confirmedDoc?.events || []).slice(-10),
      vocab: getSessionVocab(),
      supplementCount,
    });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_session_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/cancel-start
// Rolls back a confirmed (but not yet in_progress) session to pending.
// Blocked if any task has already been completed.
// Body: { deliveryGroupId }
// ---------------------------------------------------------------------------
router.post('/cancel-start', requireTelegramRoles(['warehouse', 'admin']), asyncHandler(async (req, res) => {
  const { deliveryGroupId } = req.body;
  if (!deliveryGroupId) throw appError('picking_delivery_group_required');

  const group = await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek name orderingSchedule').lean();
  if (!group) throw appError('group_not_found');

  const sessionId = await findCurrentSessionId(String(deliveryGroupId), group.orderingSchedule);
  const session = sessionId ? await OrderingSession.findById(sessionId).lean() : null;

  if (!session || session.pickingStatus !== 'confirmed') {
    return res.status(409).json({ error: 'Скасування можливе лише поки жоден товар ще не зібраний.' });
  }

  // Cancelling deletes the session's tasks, so it is only ever safe while NO
  // physical work exists to lose. Three independent signals of "someone already
  // started", each fatal on its own:
  //   completed — a product is finished;
  //   locked    — a worker is walking the warehouse with it right now;
  //   packed    — shops were ticked off, even if the task was later released.
  // A task's partial `items[].packed` never reaches the Order documents (only
  // completion does that), so deleting it silently erases work already done.
  const [completedCount, lockedCount, packedCount] = await Promise.all([
    PickingTask.countDocuments({ orderingSessionId: String(sessionId), status: 'completed' }),
    PickingTask.countDocuments({ orderingSessionId: String(sessionId), status: 'locked' }),
    PickingTask.countDocuments({
      orderingSessionId: String(sessionId),
      status: { $in: ['pending', 'locked'] },
      items: { $elemMatch: { packed: true } },
    }),
  ]);

  if (completedCount > 0) {
    return res.status(409).json({ error: 'Збирання вже розпочалось — є виконані завдання.' });
  }
  if (lockedCount > 0 || packedCount > 0) {
    return res.status(409).json({
      error: 'Збирання вже розпочалось — товари вже на руках у працівників.',
      code: 'picking_cancel_in_progress',
      lockedCount,
      packedCount,
    });
  }

  const actor = actorOf(req.telegramUser);

  // The status transition is the GATE, not a postscript: it is a single guarded
  // findOneAndUpdate pinned to fromStatus='confirmed'. If a worker claimed a task
  // between the counts above and here, their claim already moved the session to
  // in_progress, this matches nothing, and we abort having deleted nothing.
  const rolledBack = await transitionPickingStatus(sessionId, 'pending', { actor });
  if (!rolledBack) {
    return res.status(409).json({
      error: 'Збирання вже розпочалось — товари вже на руках у працівників.',
      code: 'picking_cancel_in_progress',
    });
  }

  // Belt-and-braces on the delete filter itself: only untouched pending tasks
  // are removable, so even a claim that landed inside the last microsecond keeps
  // its task instead of having it deleted out from under the worker.
  const { deletedCount } = await PickingTask.deleteMany({
    orderingSessionId: String(sessionId),
    status: 'pending',
    items: { $not: { $elemMatch: { packed: true } } },
  });

  res.json({ ok: true, pickingStatus: 'pending', deletedCount });
}));

// ---------------------------------------------------------------------------
// POST /api/picking/resolve-coverage-gap
// Body: { deliveryGroupId, productId }
// Operator's answer to a coverage gap: mark the product missing and cancel the
// positions waiting on it (sellers are notified). Re-audits afterwards so the
// caller learns immediately whether the start is now unblocked.
// ---------------------------------------------------------------------------
router.post('/resolve-coverage-gap', requireTelegramRoles(['warehouse', 'admin']), asyncHandler(async (req, res) => {
  const { deliveryGroupId, productId = null } = req.body;
  if (!deliveryGroupId) throw appError('picking_delivery_group_required');

  const group = await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek name orderingSchedule').lean();
  if (!group) throw appError('group_not_found');

  const sessionId = await findCurrentSessionId(String(deliveryGroupId), group.orderingSchedule);
  if (!sessionId) throw appError('picking_session_not_found');

  const { getBot } = require('../telegramBot');
  const { cancelledCount, archived } = await resolveCoverageGap({
    deliveryGroupId,
    orderingSessionId: sessionId,
    productId,
    bot: getBot(),
  });

  const coverage = await auditSessionCoverage({ deliveryGroupId, orderingSessionId: sessionId });

  res.json({ ok: true, cancelledCount, archived, gaps: coverage.gaps, resolved: coverage.ok });
}));

async function handleNextTaskCommand(req, res, next) {
  try {
    const user = req.telegramUser;
    const input = req.method === 'GET' ? req.query : req.body;
    const currentBlock = parseInt(input?.currentBlock, 10);
    const deliveryGroupId = input?.deliveryGroupId || null;

    if (!Number.isInteger(currentBlock) || currentBlock < 1) {
      return next(appError('picking_current_block_invalid'));
    }

    // deliveryGroupId is REQUIRED for next-task: this endpoint acquires a lock,
    // and findAndLockNext with a null group would lock the globally-next pending
    // task — potentially from a different delivery group the worker isn't picking.
    // Every real caller (per-group PickingPage) always sends it.
    if (!deliveryGroupId) {
      return next(appError('picking_delivery_group_required'));
    }

    const { sessionId } = await resolveCurrentPickingSession(deliveryGroupId);
    if (!sessionId) {
      return res.json({ task: null, reviewMode: false, message: 'Немає поточної сесії збирання' });
    }

    // Release stale locks:
    //  - always release this worker's own locks (from a previous request / page reload)
    //  - release any worker's lock that is older than timeout (abandoned tasks)
    // Does NOT touch items[].packed so partial progress is preserved for the next worker.
    await releaseWorkerAndStaleLocks(user.telegramId, deliveryGroupId);

    // Recovery: якщо сервер упав між фазою 1 (task completed) і фазою 2 (archiveProduct)
    // в out-of-stock flow — довиконуємо архівування тут, а не тільки в start-session.
    if (deliveryGroupId) {
      archiveOrphanedOutOfStockProducts(deliveryGroupId, sessionId).catch(() => {});
    }

    const { task, routeBlocked } = await findAndLockNext(
      user.telegramId,
      currentBlock,
      deliveryGroupId,
      { orderingSessionId: sessionId, fromPosition: 0, actor: actorOf(user) },
    );
    if (!task) {
      const pendingFilter = {
        status: 'pending',
        deliveryGroupId: String(deliveryGroupId),
        orderingSessionId: String(sessionId),
      };
      const pendingCount = await PickingTask.countDocuments(pendingFilter);
      return res.json({
        task: null,
        routeBlocked: routeBlocked || null,
        reviewMode: pendingCount > 0 && !routeBlocked,
        message: routeBlocked?.code === 'worker_ahead'
          ? 'Попереду вже працює інший складник. Оберіть новий блок.'
          : pendingCount > 0 ? 'Залишились пропущені задачі' : 'Немає задач для збирання',
      });
    }

    const taskData = await buildTaskResponse(task);
    if (!taskData) {
      // Product archived — release and return empty
      await PickingTask.findByIdAndUpdate(task._id, {
        $set: { status: 'pending', lockedBy: null, lockedAt: null },
      });
      const pendingFilter = { status: 'pending', deliveryGroupId: String(deliveryGroupId), orderingSessionId: String(sessionId) };
      const pendingCount = await PickingTask.countDocuments(pendingFilter);
      return res.json({
        task: null,
        reviewMode: pendingCount > 0,
        message: pendingCount > 0 ? 'Залишились пропущені задачі' : 'Немає задач для збирання',
      });
    }

    res.json({ task: taskData });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_next_failed'));
  }
}


// ---------------------------------------------------------------------------
// GET /api/picking/my-task?deliveryGroupId=...
// Returns the worker's currently locked task without releasing anything.
// Used on page load to restore interrupted picking sessions.
// ---------------------------------------------------------------------------
router.get('/my-task', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const deliveryGroupId = req.query.deliveryGroupId || null;
    if (!deliveryGroupId) return res.json({ task: null });
    const { sessionId } = await resolveCurrentPickingSession(deliveryGroupId);
    if (!sessionId) return res.json({ task: null });

    // Sorted by lockedAt DESC: with the one-task invariant there is at most one
    // match, but a doc left over from before the invariant existed must resolve
    // DETERMINISTICALLY to the most recently claimed task — an unsorted findOne
    // could resume the worker onto a task they are not physically holding.
    const task = await PickingTask.findOne({
      status: 'locked',
      lockedBy: String(user.telegramId),
      deliveryGroupId: String(deliveryGroupId),
      orderingSessionId: String(sessionId),
    })
      .sort({ lockedAt: -1 })
      .lean();

    // Legacy duplicate-lock repair belongs to the server maintenance scheduler.
    // A page read only reports the newest authoritative lock and never changes it.
    if (!task) return res.json({ task: null });

    const taskData = await buildTaskResponse(task);
    if (!taskData) return res.json({ task: null });

    res.json({ task: taskData });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_next_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/next-task
// Body: { currentBlock, deliveryGroupId }
// Command: deliberately mutates task ownership.
// A deprecated GET alias is kept for one rolling-deploy cycle so an already-open
// old Mini App does not break during Monday deployment. New clients use POST only.
// ---------------------------------------------------------------------------
const nextTaskRoleGuard = requireTelegramRoles(['warehouse', 'admin']);
router.post('/next-task', nextTaskRoleGuard, handleNextTaskCommand);
router.get('/next-task', nextTaskRoleGuard, handleNextTaskCommand); // deprecated rolling-deploy alias

// ---------------------------------------------------------------------------
// GET /api/picking/block-tasks?blockId=N&deliveryGroupId=...
// Returns active tasks from one block for picker modal (start from specific product).
// ---------------------------------------------------------------------------
router.get('/block-tasks', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const blockId = parseInt(req.query.blockId, 10);
    const deliveryGroupId = req.query.deliveryGroupId || null;

    if (!Number.isInteger(blockId) || blockId < 1) {
      return next(appError('picking_block_invalid'));
    }
    if (!deliveryGroupId) return res.json({ tasks: [] });
    const { sessionId } = await resolveCurrentPickingSession(deliveryGroupId);
    if (!sessionId) return res.json({ tasks: [] });

    // Pure read. Stale/duplicate lease cleanup is owned by the server
    // picking-maintenance scheduler, never by a modal poll.

    const filter = {
      blockId,
      status: { $in: ['pending', 'locked'] },
      deliveryGroupId: String(deliveryGroupId),
      orderingSessionId: String(sessionId),
    };

    const tasks = await PickingTask.find(filter)
      .sort({ positionIndex: 1 })
      .lean();

    const productIds = [...new Set(tasks.map((t) => String(t.productId)))];
    const products = await Product.find({ _id: { $in: productIds } }).lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    // Fetch names for workers who locked tasks
    const lockerIds = [...new Set(tasks.filter((t) => t.lockedBy).map((t) => String(t.lockedBy)))];
    const lockers = lockerIds.length
      ? await User.find({ telegramId: { $in: lockerIds } }, 'telegramId firstName lastName').lean()
      : [];
    const lockerNameMap = new Map(lockers.map((u) => [
      String(u.telegramId),
      [u.firstName, u.lastName].filter(Boolean).join(' ') || String(u.telegramId),
    ]));

    const previewTasks = [];
    for (const task of tasks) {
      const product = productMap.get(String(task.productId));
      if (!product) continue;
      const imageUrl =
        (Array.isArray(product.imageUrls) && product.imageUrls[0]) ||
        product.localImageUrl ||
        null;
      const totalQty = (task.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      const lockedBy = task.lockedBy ? String(task.lockedBy) : null;
      const lockedByMe = task.status === 'locked' && lockedBy === String(user.telegramId);
      const lockedByOther = task.status === 'locked' && !lockedByMe;

      previewTasks.push({
        taskId: String(task._id),
        productId: String(product._id),
        productTitle: getProductTitle(product),
        imageUrl,
        blockId: task.blockId,
        positionIndex: task.positionIndex,
        totalQty,
        shopCount: (task.items || []).length,
        status: task.status,
        lockedBy,
        lockedByOther,
        lockedAt: task.lockedAt ? task.lockedAt.toISOString() : null,
        lockedByName: lockedByOther && lockedBy ? (lockerNameMap.get(lockedBy) || null) : null,
      });
    }

    res.json({ tasks: previewTasks });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_block_tasks_failed'));
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/blocks-overview?deliveryGroupId=...
// Returns all blocks that still have pending/locked tasks, with item counts.
// Used by the "Показати замовлення" block-picker UI (no block input needed).
// ---------------------------------------------------------------------------
router.get('/blocks-overview', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const me = String(req.telegramUser.telegramId || '');
    const deliveryGroupId = req.query.deliveryGroupId || null;
    if (!deliveryGroupId) return res.json({ blocks: [] });
    const { sessionId } = await resolveCurrentPickingSession(deliveryGroupId);
    if (!sessionId) return res.json({ blocks: [] });

    const filter = {
      status: { $in: ['pending', 'locked'] },
      deliveryGroupId: String(deliveryGroupId),
      orderingSessionId: String(sessionId),
    };

    const tasks = await PickingTask.find(filter, 'blockId items status lockedBy').lean();

    const byBlock = new Map();
    for (const task of tasks) {
      const bid = task.blockId;
      if (!byBlock.has(bid)) byBlock.set(bid, { blockId: bid, taskCount: 0, totalQty: 0, lockedCount: 0 });
      const entry = byBlock.get(bid);
      entry.taskCount += 1;
      // totalQty = units STILL to collect: skip shops already packed (partial
      // progress survives on a pending task after its lock is released).
      entry.totalQty += (task.items || []).reduce(
        (s, it) => s + (it.packed ? 0 : Number(it.quantity || 0)),
        0,
      );
      // "Зайнято" means a COLLEAGUE holds it — the worker's own lock never blocks
      // them, so it must not dim the tile or inflate the count.
      if (task.status === 'locked' && String(task.lockedBy || '') !== me) entry.lockedCount += 1;
    }

    const blocks = [...byBlock.values()].sort((a, b) => a.blockId - b.blockId);
    res.json({ blocks });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_next_failed'));
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/queue-stats?deliveryGroupId=...
// Live queue counters for UI (pending/locked split).
// ---------------------------------------------------------------------------
router.get('/queue-stats', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const deliveryGroupId = req.query.deliveryGroupId || null;

    if (!deliveryGroupId) {
      return res.json({ pendingCount: 0, lockedByMeCount: 0, lockedByOtherCount: 0, activeCount: 0 });
    }

    const { sessionId: currentSessionId } = await resolveCurrentPickingSession(deliveryGroupId);

    // Pure read. Stale/duplicate leases are cleaned by the server maintenance
    // scheduler so a five-second UI poll cannot mutate warehouse state.

    const base = currentSessionId
      ? { deliveryGroupId: String(deliveryGroupId), orderingSessionId: String(currentSessionId) }
      : { deliveryGroupId: '__no_current_session__' };

    const [pendingCount, lockedByMeCount, lockedByOtherCount] = await Promise.all([
      PickingTask.countDocuments({ ...base, status: 'pending' }),
      PickingTask.countDocuments({ ...base, status: 'locked', lockedBy: String(user.telegramId) }),
      PickingTask.countDocuments({ ...base, status: 'locked', lockedBy: { $ne: String(user.telegramId) } }),
    ]);

    const activeCount = pendingCount + lockedByMeCount + lockedByOtherCount;
    // orderedPositions = distinct products ordered in the CURRENT session (from Orders),
    // not built tasks. This is what the pre-start "Сумарно замовлено" banner shows: it
    // is meaningful before picking starts (tasks aren't built yet) and stays stable as
    // workers pack (pendingCount shrinks). Best-effort: never break queue polling.
    const orderedPositions = await countOrderedPositions(deliveryGroupId);

    // Live pickingStatus + last events so the SessionStatusHeader chip and
    // timeline refresh on the same 5-second poll the rest of the UI uses.
    // Without this the header is frozen on whatever /start-session returned at
    // mount: after the last task is packed and maybeCompleteSession flips the
    // session to 'completed', the chip would still read "Очікує підтвердження".
    let pickingStatus = null;
    let events = [];
    let phase = null;
    let sessionSummary = null;
    let groupDayOfWeek = null;
    let presentationMode = null;
    let nextOrderingOpenAt = null;
    let windowOpen = false;
    let windowCloseAt = null;
    let windowMessage = '';
    let serverNow = new Date().toISOString();
    let pickingReadyAt = null;
    let pickingReady = false;
    let pickingReadyInMs = null;
    // Modern supplement rows are counted only for this exact current session.
    const supplementCount = await countActiveOffersForGroup(deliveryGroupId, { orderingSessionId: currentSessionId });
    try {
      const groupDoc = await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek orderingSchedule').lean();
      if (groupDoc) {
        groupDayOfWeek = groupDoc.dayOfWeek;
        const statusNow = new Date();
        const windowState = isOrderingOpen(groupDoc.orderingSchedule, statusNow);
        const readiness = getPickingReadiness(groupDoc.orderingSchedule, statusNow);
        serverNow = readiness.serverNow.toISOString();
        pickingReadyAt = readiness.pickingReadyAt.toISOString();
        pickingReady = readiness.pickingReady;
        pickingReadyInMs = readiness.pickingReadyInMs;
        windowOpen = !!windowState.isOpen;
        windowMessage = windowState.message || '';
        windowCloseAt = windowOpen
          ? getOrderingWindowCloseAt(groupDoc.orderingSchedule, statusNow).toISOString()
          : null;
        nextOrderingOpenAt = getNextOrderingWindowOpenAt(groupDoc.orderingSchedule, statusNow).toISOString();
            // findCurrentSessionId, НЕ getOrCreate: це опитування раз на 5 секунд для
        // ПОКАЗУ сторінки. Створювати сесію тут означало, що достатньо відкрити
        // «Збирання» на групі з ще відкритим вікном замовлень — і в базі
        // з'являлась порожня OrderingSession, яку ніхто не просив (сам
        // /start-session у цьому стані виходить раніше й нічого не створює).
        // Немає сесії — немає й статусу: клієнт просто не малює чип, а вхід у
        // віртуальний блок дозамовлень від сесії не залежить.
        const sessionId = await findCurrentSessionId(String(deliveryGroupId), groupDoc.orderingSchedule);
        const sessionDoc = sessionId
          ? await OrderingSession.findById(sessionId, 'pickingStatus events seq openDate finalSummary').lean()
          : null;
        if (sessionDoc) {
          pickingStatus = sessionDoc.pickingStatus || 'pending';
          events = (sessionDoc.events || []).slice(-10);
          phase = await computeSessionPhase({
            deliveryGroupId,
            sessionId,
            pickingStatus,
            orderingSchedule: groupDoc.orderingSchedule,
          });
          sessionSummary = await buildSessionSummary(phase, {
            deliveryGroupId, sessionId, session: sessionDoc,
          });
        } else {
          phase = windowOpen ? 'ordering_open' : 'idle';
        }
        presentationMode = deriveSessionPresentationMode({
          phase,
          nextOrderingOpenAt,
        });
      }
    } catch (e) {
    }

    res.json({
      pendingCount, lockedByMeCount, lockedByOtherCount, activeCount,
      orderedPositions, pickingStatus, events, phase, sessionSummary, groupDayOfWeek,
      presentationMode, nextOrderingOpenAt, windowOpen, windowCloseAt, windowMessage,
      serverNow, pickingReadyAt, pickingReady, pickingReadyInMs,
      supplementCount,
    });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_next_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/complete
// Body: { items: [{ orderId, actualQty }], nextBlock?: N }
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/complete', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const { items = [], nextBlock } = req.body;

    const { completedTask, nextTask: nextRaw, routeBlocked, closureBlockers = [] } = await completePickingTask({
      taskId: req.params.taskId,
      userTelegramId: user.telegramId,
      userFirstName:  user.firstName,
      userLastName:   user.lastName,
      userRole:       user.role,
      items,
      nextBlock,
    });

    const nextTaskData = nextRaw ? await buildTaskResponse(nextRaw) : null;
    res.json({ message: 'Task completed', nextTask: nextTaskData, routeBlocked: routeBlocked || null, closureBlockers });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    if (err.code === 'picking_task_items_changed') return next(appError('picking_task_items_changed'));
    if (err.code === 'picking_task_not_found') return next(appError('picking_task_not_found'));
    if (err.code === 'expired_lock') return next(appError('expired_lock'));
    next(appError('picking_complete_failed'));
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/picking/tasks/:taskId/progress
// Body: { packedOrderIds: string[] }
// Saves partial packed state without completing the task.
// ---------------------------------------------------------------------------
router.patch('/tasks/:taskId/progress', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const { packedOrderIds = [] } = req.body;

    const task = await PickingTask.findById(req.params.taskId);
    if (!task) return next(appError('picking_task_not_found'));
    if (String(task.lockedBy || '') !== String(user.telegramId || '')) return next(appError('expired_lock'));

    const packedSet = new Set(packedOrderIds.map(String));
    const actor = actorOf(user);
    const packedAt = new Date();
    const newItems = task.items.map((it) => {
      const plain = typeof it.toObject === 'function' ? it.toObject() : { ...it };
      const wasPacked = Boolean(plain.packed);
      const shouldBePacked = packedSet.has(String(it.orderId));

      plain.packed = shouldBePacked;
      if (shouldBePacked && !wasPacked) {
        // Attribute only the FALSE -> TRUE transition. Re-saving a snapshot must
        // never steal authorship from the worker who originally ticked the box.
        plain.packedBy = actor.by || null;
        plain.packedByName = actor.byName || '';
        plain.packedAt = packedAt;
      } else if (!shouldBePacked) {
        // Unticking means the physical fact is being revoked; its old author is
        // no longer meaningful and must not reappear if somebody checks it later.
        plain.packedBy = null;
        plain.packedByName = '';
        plain.packedAt = null;
      }
      return plain;
    });

    // Atomic compare-and-swap: only writes if WE still hold the lock AND the
    // task hasn't been modified since we read it (__v). Closes the lost-update
    // race between two saves and the lock-stolen-mid-save (force-claim) TOCTOU.
    // Refreshing lockedAt also acts as a heartbeat so an actively-saving worker
    // is not force-claimed.
    const updated = await PickingTask.findOneAndUpdate(
      {
        _id: task._id,
        status: 'locked',
        lockedBy: String(user.telegramId || ''),
        __v: task.__v,
      },
      { $set: { items: newItems, lockedAt: new Date() }, $inc: { __v: 1 } },
      { new: true },
    );
    if (!updated) return next(appError('expired_lock'));

    res.json({ ok: true });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_progress_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/release
// Body: { packedOrderIds?: string[] }
// Explicit "leave this task" action. Preserves progress and unlocks immediately.
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/release', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const packedOrderIds = Array.isArray(req.body?.packedOrderIds) ? req.body.packedOrderIds : null;
    const result = await releasePickingTask({
      taskId: req.params.taskId,
      userTelegramId: user.telegramId,
      userFirstName: user.firstName,
      userLastName: user.lastName,
      packedOrderIds,
    });
    res.json({
      ok: true,
      released: Boolean(result?.released),
      alreadyReleased: Boolean(result?.alreadyReleased),
    });
  } catch (err) {
    if (err?.code === 'picking_task_not_found') return next(appError('picking_task_not_found'));
    if (err?.code === 'expired_lock') return next(appError('expired_lock'));
    if (err?.code === 'picking_release_unavailable') {
      return res.status(409).json({ code: 'picking_release_unavailable', message: 'Це завдання вже завершене і його не можна повернути в чергу.' });
    }
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_progress_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/heartbeat
// "I still have this product in my hands." Refreshes lockedAt only while the
// worker still owns a FRESH lease. A Mini App frozen in the background must not
// wake up after 10 minutes and silently resurrect a lease that already expired.
//
// When the lease is gone, return a precise state so the resumed client can
// reconcile the stale card immediately instead of waiting for the next action to
// fail with expired_lock.
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/heartbeat', requireTelegramRoles(['warehouse', 'admin']), asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const uid = String(user.telegramId || '');
  const taskId = String(req.params.taskId);
  const now = new Date();
  const freshAfter = new Date(now.getTime() - LOCK_TIMEOUT_MS);

  // Refresh only a still-valid lease. This makes the 5-minute timeout a real
  // boundary rather than an opportunistic cleanup performed only by queue polls.
  const refreshed = await PickingTask.findOneAndUpdate(
    {
      _id: taskId,
      status: 'locked',
      lockedBy: uid,
      lockedAt: { $gte: freshAfter },
    },
    { $set: { lockedAt: now } },
    { new: true },
  ).lean();

  if (refreshed) return res.json({ ok: true, held: true, state: 'mine' });

  let current = await PickingTask.findById(
    taskId,
    '_id status lockedBy lockedAt deliveryGroupId orderingSessionId',
  ).lean();

  if (!current) return res.json({ ok: true, held: false, state: 'missing' });

  // If this device still owns the row but its heartbeat gap exceeded the lease,
  // release only THIS exact stale lock. The compare on lockedAt prevents us from
  // undoing a concurrent re-claim/heartbeat that happened after the read.
  if (current.status === 'locked' && String(current.lockedBy || '') === uid) {
    const staleAt = current.lockedAt ? new Date(current.lockedAt) : null;
    if (!staleAt || staleAt < freshAfter) {
      const released = await PickingTask.findOneAndUpdate(
        {
          _id: current._id,
          status: 'locked',
          lockedBy: uid,
          lockedAt: current.lockedAt || null,
        },
        { $set: { status: 'pending', lockedBy: null, lockedAt: null } },
        { new: true },
      ).lean();
      current = released || await PickingTask.findById(
        taskId,
        '_id status lockedBy lockedAt deliveryGroupId orderingSessionId',
      ).lean();
    }
  }

  if (!current) return res.json({ ok: true, held: false, state: 'missing' });
  if (current.status === 'completed') return res.json({ ok: true, held: false, state: 'completed' });
  if (current.status === 'locked') {
    if (String(current.lockedBy || '') === uid) {
      // Rare race: ownership became ours again between the guarded refresh and
      // the follow-up read. Refresh once more and keep the card.
      await PickingTask.updateOne(
        { _id: current._id, status: 'locked', lockedBy: uid },
        { $set: { lockedAt: now } },
      );
      return res.json({ ok: true, held: true, state: 'mine' });
    }
    return res.json({ ok: true, held: false, state: 'other_worker' });
  }

  if (current.status === 'pending') {
    // Do not offer automatic resume into a task from an old ordering cycle.
    const { sessionId } = await resolveCurrentPickingSession(current.deliveryGroupId);
    if (!sessionId || String(current.orderingSessionId || '') !== String(sessionId)) {
      return res.json({ ok: true, held: false, state: 'session_changed' });
    }
    return res.json({ ok: true, held: false, state: 'available' });
  }

  return res.json({ ok: true, held: false, state: 'missing' });
}));

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/claim  — atomically lock a task from the review list
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/claim', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const taskId = String(req.params.taskId);

    // Lock prevents a worker who taps "Взяти" twice across the network from
    // both racing the Mongo findOneAndUpdate. The first wins, the second sees
    // status='locked' with lockedBy=themselves and gets the same task back.
    await withLock(`picking:${taskId}:claim`, async () => {
      const claimed = await PickingTask.findOneAndUpdate(
        { _id: taskId, status: 'pending' },
        { $set: { status: 'locked', lockedBy: user.telegramId, lockedAt: new Date() } },
        { new: true },
      );
      if (!claimed) {
        const existing = await PickingTask.findById(taskId).lean();
        if (!existing) return next(appError('picking_claim_unavailable'));

        if (existing.status === 'locked' && String(existing.lockedBy || '') === String(user.telegramId || '')) {
          const mine = await buildTaskResponse(existing);
          if (mine) {
            // Switching BACK to a task we already hold is still a switch — drop
            // whatever else we were holding so the invariant survives it.
            await releaseOtherLocksOfWorker(user.telegramId, existing._id);
            await markSessionInProgress(existing.orderingSessionId, actorOf(user));
            return res.json({ task: mine });
          }
        }

        if (existing.status === 'locked') return next(appError('picking_claim_taken_by_other'));
        return next(appError('picking_claim_unavailable'));
      }

      const taskData = await buildTaskResponse(claimed);
      if (!taskData) {
        await PickingTask.findByIdAndUpdate(claimed._id, { $set: { status: 'pending', lockedBy: null, lockedAt: null } });
        return next(appError('picking_product_not_found'));
      }

      // Invariant: one worker = at most one locked task. Released only now that
      // the new lock is secured and the response is guaranteed — an earlier
      // release would strand the worker if the claim above had lost the race.
      await releaseOtherLocksOfWorker(user.telegramId, claimed._id);

      // Picking has physically begun → close the cancel-start window.
      await markSessionInProgress(claimed.orderingSessionId, actorOf(user));

      res.json({ task: taskData });
    }, { ttlMs: 10_000, waitMs: 5_000 });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_claim_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/out-of-stock
// Body: { nextBlock?: N, packedOrderIds?: string[] }
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/out-of-stock', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const { nextBlock, packedOrderIds = [] } = req.body;

    const { nextTask: nextRaw, routeBlocked, closureBlockers = [] } = await outOfStockPickingTask({
      taskId: req.params.taskId,
      userTelegramId: user.telegramId,
      userFirstName:  user.firstName,
      userLastName:   user.lastName,
      userRole:       user.role,
      packedOrderIds,
      nextBlock,
    });

    const nextTaskData = nextRaw ? await buildTaskResponse(nextRaw) : null;

    res.json({ message: 'Out-of-stock recorded', nextTask: nextTaskData, routeBlocked: routeBlocked || null, closureBlockers });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    // Map service-thrown codes to clean 4xx (mirrors /complete) — a stale / wrong /
    // nonexistent taskId must answer 404/409, not crash to 500.
    if (err && err.code === 'picking_task_not_found') return next(appError('picking_task_not_found'));
    if (err && err.code === 'expired_lock') return next(appError('expired_lock'));
    if (err && err.code === 'picking_claim_taken_by_other') return next(appError('picking_claim_taken_by_other'));
    if (err && err.code === 'picking_oos_already_packed') return next(appError('picking_oos_already_packed'));
    next(appError('picking_oos_failed'));
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/locked-tasks?deliveryGroupId=...
// Returns tasks currently locked by other workers (for end-of-queue UI).
// ---------------------------------------------------------------------------
router.get('/locked-tasks', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const deliveryGroupId = req.query.deliveryGroupId || null;
    if (!deliveryGroupId) return res.json({ tasks: [] });
    const { sessionId } = await resolveCurrentPickingSession(deliveryGroupId);
    if (!sessionId) return res.json({ tasks: [] });

    const filter = {
      status: 'locked',
      lockedBy: { $ne: String(user.telegramId) },
      deliveryGroupId: String(deliveryGroupId),
      orderingSessionId: String(sessionId),
    };

    const tasks = await PickingTask.find(
      filter,
      '_id productId blockId positionIndex lockedBy lockedAt items'
    ).lean();

    const productIds = [...new Set(tasks.map((t) => String(t.productId)))];
    const products = await Product.find(
      { _id: { $in: productIds } },
      'brand model category'
    ).lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const result = tasks.map((task) => {
      const product = productMap.get(String(task.productId));
      return {
        taskId: String(task._id),
        productTitle: product
          ? (product.brand || product.model || product.category || '—')
          : '—',
        blockId: task.blockId,
        positionIndex: task.positionIndex,
        lockedAt: task.lockedAt,
        shopCount: (task.items || []).length,
      };
    });

    res.json({ tasks: result });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_next_failed'));
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/session-closure?deliveryGroupId=...
// Read-only integrity view of the CURRENT session. Historical/foreign state is
// returned only as warnings and NEVER participates in the current-session gate.
// ---------------------------------------------------------------------------
router.get('/session-closure', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const deliveryGroupId = String(req.query.deliveryGroupId || '');
    if (!deliveryGroupId) return res.status(400).json({ error: 'delivery_group_required' });

    const resolved = await resolveCurrentPickingSession(deliveryGroupId);
    if (!resolved.sessionId) {
      return res.json({ ok: true, blockers: [], warnings: [], session: null });
    }

    const audit = await auditSessionClosure({
      deliveryGroupId,
      orderingSessionId: resolved.sessionId,
    });
    return res.json(audit);
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    return next(appError('picking_next_failed'));
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/shift-board?deliveryGroupId=...
// Live "shift board": who is working, how many tasks each person completed,
// session start time, last activity time.
// ---------------------------------------------------------------------------
router.get('/shift-board', requireTelegramRoles(['admin']), async (req, res, next) => {
  try {
    const { deliveryGroupId } = req.query;
    if (!deliveryGroupId) return res.json({ workers: [], totalCompleted: 0, totalPending: 0, sessionStart: null, lastActivity: null, groupName: '' });

    const dgId = String(deliveryGroupId);

    // Group name + session start time
    const group = await DeliveryGroup.findById(dgId, 'name dayOfWeek orderingSchedule').lean();
    const groupName = group?.name || '';

    // Session start = when this picking session was confirmed. Lives on the
    // OrderingSession (not the group), so changing the delivery day cannot
    // stamp the start time of a future cycle onto a finished one.
    let sessionStart = null;
    let sessionId = null;
    if (group) {
      sessionId = await findCurrentSessionId(dgId, group.orderingSchedule);
      const sessionDoc = sessionId
        ? await OrderingSession.findById(sessionId, 'pickingConfirmedAt').lean()
        : null;
      sessionStart = sessionDoc?.pickingConfirmedAt || null;
    }
    // Сесія поточного циклу ще не матеріалізована → дошка порожня. Фолбек на
    // deliveryGroupId показав би completed-задачі ВСІХ минулих сесій (лічильники
    // не скидались би на новому циклі). Той самий патерн, що й у /queue-stats.
    const sessionScope = sessionId ? { orderingSessionId: sessionId } : { deliveryGroupId: '__no_current_session__' };

    // Active workers (currently have a locked task)
    const lockedTasks = await PickingTask.find(
      { ...sessionScope, deliveryGroupId: dgId, status: 'locked', lockedBy: { $ne: null } },
      'lockedBy lockedAt',
    ).lean();
    const activeWorkerIds = new Set(lockedTasks.map((t) => String(t.lockedBy)));

    // Completed-task counts scoped to the CURRENT session so finished cycles
    // do not keep inflating the board. Previously this was kept clean by a
    // deleteMany on start-session; with session stamping the filter does it
    // structurally and history survives.
    const completedTasks = await PickingTask.find(
      { ...sessionScope, status: 'completed' },
      'updatedAt',
    ).lean();
    const totalCompleted = completedTasks.length;
    const totalPending = await PickingTask.countDocuments({ ...sessionScope, deliveryGroupId: dgId, status: 'pending' });
    const ordinaryLastActivity = completedTasks.length
      ? completedTasks.reduce((max, t) => (t.updatedAt > max ? t.updatedAt : max), completedTasks[0].updatedAt)
      : null;
    const supplementShift = sessionId
      ? await getSupplementShiftSummary({ orderingSessionId: sessionId, deliveryGroupId: dgId }).catch(() => ({ totalPacked: 0, lastActivity: null, workers: [] }))
      : { totalPacked: 0, lastActivity: null, workers: [] };
    const totalSupplementPacked = Number(supplementShift.totalPacked || 0);
    const lastActivity = [ordinaryLastActivity, supplementShift.lastActivity]
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;

    // Per-worker stats: count COMPLETED picking tasks of THIS session, grouped by
    // who finalised each one (completedBy). Scoped exactly like totalCompleted
    // (sessionScope) so the numbers agree and reset every cycle. The previous
    // Order.history aggregation was wrong twice over: it had no session/date
    // filter (so counts grew forever across weeks) and credited only whoever
    // packed an order's LAST item. completedBy is null for system-archive
    // completions, so those are excluded.
    const workerStats = await PickingTask.aggregate([
      { $match: { ...sessionScope, status: 'completed', completedBy: { $ne: null } } },
      { $group: { _id: '$completedBy', name: { $first: '$completedByName' }, tasksCompleted: { $sum: 1 } } },
    ]);

    // Merge with User collection for name fallback
    const workerIds = workerStats.map((w) => String(w._id));
    // A worker may have packed some shops and then handed the task to another
    // worker without ever being the final completer. Keep those people in the
    // roster too: per-checkbox authorship is real work and must not disappear
    // just because completedBy belongs to somebody else.
    const packedWorkerIds = sessionId
      ? (await PickingTask.distinct('items.packedBy', {
        orderingSessionId: sessionId,
        deliveryGroupId: dgId,
        'items.packedBy': { $ne: null },
      })).map((value) => String(value || '')).filter(Boolean)
      : [];
    const supplementWorkerIds = (supplementShift.workers || []).map((row) => String(row.telegramId || '')).filter(Boolean);
    const allWorkerIds = [...new Set([...workerIds, ...activeWorkerIds, ...packedWorkerIds, ...supplementWorkerIds])];

    const users = allWorkerIds.length
      ? await User.find({ telegramId: { $in: allWorkerIds } }, 'telegramId firstName lastName').lean()
      : [];
    const userNameMap = new Map(users.map((u) => [
      String(u.telegramId),
      [u.firstName, u.lastName].filter(Boolean).join(' ') || String(u.telegramId),
    ]));
    const workerUsernameMap = await getTelegramUsernameMap(allWorkerIds);

    const statsMap = new Map(workerStats.map((w) => [String(w._id), w]));
    const supplementStatsMap = new Map((supplementShift.workers || []).map((row) => [String(row.telegramId), row]));

    const workers = allWorkerIds.map((id) => {
      const stat = statsMap.get(String(id));
      const supplementStat = supplementStatsMap.get(String(id));
      return {
        telegramId: id,
        name: stat?.name || supplementStat?.name || userNameMap.get(id) || id,
        username: workerUsernameMap.get(String(id)) || '',
        tasksCompleted: stat?.tasksCompleted || 0,
        supplementPackedCount: supplementStat?.supplementPackedCount || 0,
        isActive: activeWorkerIds.has(id),
      };
    }).sort((a, b) =>
      b.tasksCompleted - a.tasksCompleted
      || b.supplementPackedCount - a.supplementPackedCount
      || (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0));

    // ── Order-level "не завершено" aggregation (read-only data for the Зміна card) ──
    // Three views the operator wants visibility into, NO actions attached:
    //   A. currentSession — active orders of THIS session with unpacked positions
    //      (honest before picking starts, when no PickingTasks exist yet).
    //   B. stale          — active orders of the group NOT in the current session
    //      (stranded from a prior cycle / after a reschedule). Mirrors the
    //      shop-status guard: only reported when the ordering window is CLOSED, to
    //      avoid the false positives that occur while the window is still open.
    //   C. abandonedSessions — OrderingSession docs left confirmed/in_progress that
    //      are NOT the current one (a cycle that never reached completed).
    // Best-effort: a failure here must never break the shift board.
    let unfinished = null;
    try {
      if (group && sessionId) {
            const { isOpen } = isOrderingOpen(group.orderingSchedule);
        const sessionMeta = await OrderingSession.findById(sessionId, 'seq openDate pickingStatus').lean();

        const positionsLeft = (o) => (o.items || []).filter((i) => !i.cancelled && !i.packed && !i.skipped && !i.voided).length;
        const mapOrder = (o) => ({
          orderId: String(o._id),
          orderNumber: o.orderNumber,
          shopName: o.buyerSnapshot?.shopName || '—',
          shopCity: o.buyerSnapshot?.shopCity || '',
          positionCount: positionsLeft(o),
        });

        // A. Незібране в поточній сесії
        const currentOrders = await Order.find(
          { 'buyerSnapshot.deliveryGroupId': dgId, status: { $in: ['new', 'in_progress'] }, orderingSessionId: sessionId },
          'orderNumber buyerSnapshot items',
        ).lean();
        const currentUnfinished = currentOrders
          .map(mapOrder)
          .filter((o) => o.positionCount > 0)
          .sort((a, b) => (a.orderNumber || 0) - (b.orderNumber || 0));
        const currentPositionCount = currentUnfinished.reduce((s, o) => s + o.positionCount, 0);

        // B. Застрягле поза сесією (тільки коли вікно закрите)
        let staleList = [];
        if (!isOpen) {
          const staleOrders = await Order.find(
            { 'buyerSnapshot.deliveryGroupId': dgId, status: { $in: ['new', 'in_progress'] }, orderingSessionId: { $ne: sessionId } },
            'orderNumber buyerSnapshot items',
          ).lean();
          staleList = staleOrders
            .map(mapOrder)
            .sort((a, b) => (a.orderNumber || 0) - (b.orderNumber || 0));
        }
        const stalePositionCount = staleList.reduce((s, o) => s + o.positionCount, 0);

        // C. Завислі попередні сесії
        const abandonedDocs = await OrderingSession.find(
          { groupId: dgId, _id: { $ne: sessionId }, pickingStatus: { $in: ['confirmed', 'in_progress'] } },
          'seq openDate pickingStatus',
        ).sort({ openDate: -1 }).limit(10).lean();

        unfinished = {
          currentSession: {
            seq: sessionMeta?.seq ?? null,
            openDate: sessionMeta?.openDate ?? null,
            pickingStatus: sessionMeta?.pickingStatus ?? 'pending',
            orderCount: currentUnfinished.length,
            positionCount: currentPositionCount,
            orders: currentUnfinished,
          },
          stale: {
            windowOpen: isOpen,
            orderCount: staleList.length,
            positionCount: stalePositionCount,
            orders: staleList,
          },
          abandonedSessions: abandonedDocs.map((s) => ({
            sessionId: String(s._id),
            seq: s.seq ?? null,
            openDate: s.openDate || null,
            pickingStatus: s.pickingStatus,
          })),
        };
      }
    } catch (e) {
    }

    // Canonical session integrity. HARD blockers are current-session only;
    // old/foreign orders/tasks are warnings, so last week's debris can be shown
    // without ever stopping today's workers. Best-effort for this dashboard.
    let sessionClosure = null;
    try {
      if (sessionId) {
        sessionClosure = await auditSessionClosure({
          deliveryGroupId: dgId,
          orderingSessionId: sessionId,
        });
      }
    } catch (e) {
    }

    // ── "Переглянули каталог" — who pressed «Я переглянув усі товари» this session ──
    // Roster of every seller/admin assigned to a shop of this group, each with the
    // timestamp of their mark (or null). Purely informational, so it is built
    // best-effort and a failure here must never break the board.
    let catalogReview = null;
    try {
      if (sessionId) {
        const shops = await Shop.find({ deliveryGroupId: dgId, isActive: true }, 'name cityId')
          .populate('cityId', 'name').lean();
        const shopById = new Map(shops.map((s) => [String(s._id), s]));

        const staff = shops.length
          ? await User.find(
            { role: { $in: ['seller', 'admin'] }, shopId: { $in: shops.map((s) => s._id) } },
            'telegramId firstName lastName shopId',
          ).lean()
          : [];

        const marks = await CatalogReview.find(
          { groupId: dgId, sessionId }, 'telegramId userName shopId shopName at',
        ).lean();
        const reviewUsernameMap = await getTelegramUsernameMap([
          ...staff.map((u) => u.telegramId),
          ...marks.map((m) => m.telegramId),
        ]);

        // The roster is a UNION of two sources, not a lookup on one:
        //   • the marks themselves — historical facts, read from their own
        //     snapshot (who, which shop, when). These survive the seller being
        //     moved to another shop, or unassigned entirely, mid-cycle.
        //   • currently assigned staff — needed only to list who has NOT marked.
        // Keying purely off today's staff (the first version) meant an unassigned
        // seller's mark vanished from the board.
        //
        // ONE ROW PER PERSON: the key is telegramId alone, never telegramId|shopId.
        // A mark belongs to the seller (see models/CatalogReview.js), so somebody
        // moved mid-cycle must not show up twice — marked on the old shop, unmarked
        // on the new one — freezing the counter at "1 / 2" for one human who cannot
        // press the button a second time anyway (unique {sessionId, telegramId}).
        //
        // WHICH SHOP IS SHOWN: for a MARKED seller it is the SNAPSHOT shop — the
        // one they stood on when they pressed the button. That is the fact staff
        // asked to see ("хто на якому магазині натиснув"), and it must not drift
        // when the person is moved afterwards. Showing their CURRENT shop (the
        // first version) turned the row into a lie: press on A, move to B, board
        // says B. Unmarked sellers have no snapshot, so they show their current shop.
        const markedIds = new Set();
        const sellers = marks.map((m) => {
          const tgId = String(m.telegramId);
          markedIds.add(tgId);
          const shop = shopById.get(String(m.shopId));
          return {
            telegramId: tgId,
            name: m.userName || String(m.telegramId),
            username: reviewUsernameMap.get(tgId) || '',
            // Prefer the live shop name (renames), fall back to the snapshot —
            // which is all we have if the shop left the group since.
            shopName: shop?.name || m.shopName || '—',
            shopCity: shop?.cityId?.name || '',
            at: m.at,
          };
        });

        for (const u of staff) {
          if (markedIds.has(String(u.telegramId))) continue;
          const shop = shopById.get(String(u.shopId));
          sellers.push({
            telegramId: String(u.telegramId),
            name: [u.firstName, u.lastName].filter(Boolean).join(' ') || String(u.telegramId),
            username: reviewUsernameMap.get(String(u.telegramId)) || '',
            shopName: shop?.name || '—',
            shopCity: shop?.cityId?.name || '',
            at: null,
          });
        }

        sellers.sort((a, b) => {
          // Marked first (newest mark on top), then the rest alphabetically by shop.
          if (!!a.at !== !!b.at) return a.at ? -1 : 1;
          if (a.at && b.at) return new Date(b.at) - new Date(a.at);
          return String(a.shopName).localeCompare(String(b.shopName), 'uk');
        });

        catalogReview = {
          reviewedCount: sellers.filter((s) => s.at).length,
          totalCount: sellers.length,
          sellers,
        };
      }
    } catch (e) {
    }

    res.json({ groupName, sessionStart, lastActivity, workers, totalCompleted, totalPending, totalSupplementPacked, unfinished, sessionClosure, catalogReview });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_next_failed'));
  }
 });

// ---------------------------------------------------------------------------
// GET /api/picking/shift-board/worker-history
// Paginated task history for ONE warehouse worker in the CURRENT ordering
// session. Loaded only when the admin expands that worker on «Зміна», so the
// 15-second shift-board poll stays small even after hundreds of tasks.
// ---------------------------------------------------------------------------
router.get('/shift-board/worker-history', requireTelegramRoles(['admin']), async (req, res, next) => {
  try {
    const deliveryGroupId = String(req.query.deliveryGroupId || '');
    const workerTelegramId = String(req.query.workerTelegramId || '');
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);

    if (!deliveryGroupId || !workerTelegramId) {
      return res.status(400).json({ error: 'invalid_request', message: 'Потрібні deliveryGroupId і workerTelegramId.' });
    }

    const group = await DeliveryGroup.findById(deliveryGroupId, 'orderingSchedule').lean();
    if (!group) return res.json({ items: [], total: 0, limit, offset, hasMore: false });

    const sessionId = await findCurrentSessionId(deliveryGroupId, group.orderingSchedule);
    if (!sessionId) return res.json({ items: [], total: 0, limit, offset, hasMore: false });

    const workerMatch = {
      orderingSessionId: sessionId,
      deliveryGroupId,
      $or: [
        { completedBy: workerTelegramId },
        { status: 'locked', lockedBy: workerTelegramId },
        { items: { $elemMatch: { packed: true, packedBy: workerTelegramId } } },
      ],
    };

    // Fetch the top N rows from each work stream, then merge chronologically.
    // To produce global rows [offset, offset+limit), top offset+limit from EACH
    // independently sorted stream is sufficient and avoids mixing unlike units in
    // storage merely for pagination.
    const fetchLimit = offset + limit;
    const [ordinaryTotal, tasks, supplementHistory] = await Promise.all([
      PickingTask.countDocuments(workerMatch),
      PickingTask.find(
        workerMatch,
        'productId blockId positionIndex status lockedBy lockedAt items completedBy completedByName completionReason updatedAt',
      )
        .sort({ updatedAt: -1, _id: -1 })
        .limit(fetchLimit)
        .lean(),
      getSupplementWorkerHistory({
        orderingSessionId: sessionId,
        deliveryGroupId,
        workerTelegramId,
        fetchLimit,
      }),
    ]);

    const productIds = [...new Set(tasks.map((task) => String(task.productId || '')).filter(Boolean))];
    const [products, sessionMeta] = await Promise.all([
      productIds.length
        ? Product.find(
          { _id: { $in: productIds } },
          '_id brand model category orderNumber imageUrls localImageUrl',
        ).lean()
        : [],
      OrderingSession.findById(sessionId, 'shopNumbers').lean(),
    ]);
    const productInfoMap = new Map(products.map((product) => [String(product._id), {
      title: getProductTitle(product),
      imageUrl: (Array.isArray(product.imageUrls) && product.imageUrls[0]) || product.localImageUrl || null,
    }]));
    const shopLookup = buildShopNumberLookup(sessionMeta?.shopNumbers);
    const boxNumberFor = (item) =>
      (item.shopId != null ? shopLookup.byId.get(String(item.shopId)) : undefined) ??
      shopLookup.byName.get(String(item.shopName || '')) ??
      null;

    const ordinaryItems = tasks.map((task) => {
      const workerPackedItems = (task.items || []).filter(
        (item) => item.packed && String(item.packedBy || '') === workerTelegramId,
      );
      const workerPackedAt = workerPackedItems.reduce((latest, item) => {
        if (!item.packedAt) return latest;
        if (!latest || new Date(item.packedAt) > new Date(latest)) return item.packedAt;
        return latest;
      }, null);
      const isActiveForWorker = task.status === 'locked' && String(task.lockedBy || '') === workerTelegramId;
      const completedByWorker = String(task.completedBy || '') === workerTelegramId;
      const at = [
        workerPackedAt,
        isActiveForWorker ? task.lockedAt : null,
        completedByWorker ? task.updatedAt : null,
      ].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || task.updatedAt;
      const productInfo = productInfoMap.get(String(task.productId || ''));
      const shops = (task.items || [])
        .map((item) => {
          const packedBy = item.packedBy ? String(item.packedBy) : null;
          const markedByWorker = Boolean(item.packed && packedBy === workerTelegramId);
          return {
            orderId: String(item.orderId || ''),
            shopId: item.shopId ? String(item.shopId) : null,
            shopName: item.shopName || '—',
            shopNumber: boxNumberFor(item),
            sellerName: item.sellerName || '',
            quantity: Number(item.packedQuantity ?? item.quantity ?? 0),
            packed: Boolean(item.packed),
            packedBy,
            packedByName: item.packedByName || '',
            packedAt: item.packedAt || null,
            markedByWorker,
          };
        })
        .sort((a, b) =>
          (a.shopNumber ?? Infinity) - (b.shopNumber ?? Infinity)
          || String(a.shopName).localeCompare(String(b.shopName), 'uk'));

      return {
        taskId: String(task._id),
        productId: String(task.productId || ''),
        productTitle: productInfo?.title || `Товар ${String(task.productId || '')}`,
        imageUrl: productInfo?.imageUrl || null,
        blockId: task.blockId,
        positionIndex: task.positionIndex,
        status: task.status,
        completionReason: task.completionReason || null,
        packedCount: (task.items || []).filter((item) => item.packed).length,
        itemCount: (task.items || []).length,
        workerPackedCount: workerPackedItems.length,
        shops,
        isActiveForWorker,
        completedByWorker,
        at,
      };
    });

    const total = ordinaryTotal + Number(supplementHistory.total || 0);
    const items = [...ordinaryItems, ...(supplementHistory.items || [])]
      .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0) || String(b.taskId).localeCompare(String(a.taskId)))
      .slice(offset, offset + limit);

    res.json({
      items,
      total,
      ordinaryTotal,
      supplementTotal: Number(supplementHistory.total || 0),
      limit,
      offset,
      hasMore: offset + items.length < total,
      sessionId: String(sessionId),
    });
  } catch (err) {
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    next(appError('picking_next_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/force-claim
// Force-release a stale lock and claim the task for the current worker.
// Only allowed if the task has been locked for more than FORCE_CLAIM_AFTER_MS.
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/force-claim', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const taskId = String(req.params.taskId);

    // Same lock key as the normal claim so a regular "Взяти" and a "Перехопити"
    // on the SAME task serialise against each other across all workers. The
    // pinned lockedBy/lockedAt filter inside forceClaimPickingTask is the
    // correctness backstop; this lock removes the contention window entirely.
    const { task: claimed } = await withLock(
      `picking:${taskId}:claim`,
      () => forceClaimPickingTask({ taskId, userTelegramId: user.telegramId }),
      { ttlMs: 10_000, waitMs: 5_000 },
    );

    const taskData = await buildTaskResponse(claimed);
    if (!taskData) return next(appError('picking_product_not_found'));
    res.json({ task: taskData });
  } catch (err) {
    if (err.code === 'picking_claim_too_soon') {
      return res.status(409).json({
        code: 'picking_claim_too_soon',
        message: `Задача заблокована ${Math.round((err.lockedAgo || 0) / 1000)} с тому. Перехоплення доступне після ${Math.ceil(FORCE_CLAIM_AFTER_MS / 60000)} хвилин.`,
      });
    }
    if (err && (err.name === 'AppError' || err.name === 'CastError' || isTransientTx(err))) return next(err);
    if (err.code === 'picking_task_not_found') return next(appError('picking_task_not_found'));
    if (err.code === 'picking_claim_unavailable') return next(appError('picking_claim_unavailable'));
    next(appError('picking_claim_failed'));
  }
});

module.exports = router;
