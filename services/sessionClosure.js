'use strict';

/**
 * Canonical read-only closure audit for ONE OrderingSession.
 *
 * blockers = defects that belong to this exact session and may stop ONLY this
 * session from becoming completed.
 * warnings = informational/non-blocking state (historical/foreign debris,
 * parked orders, or a conflict that appeared after picking start). Warnings are
 * visible for repair but NEVER block the current session or next week's work.
 */
const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const OrderingSession = require('../models/OrderingSession');
const Product = require('../models/Product');
const SupplementWave = require('../models/SupplementWave');
const { auditSessionCoverage } = require('./sessionCoverage');
const { isTerminalOrderItem } = require('../utils/orderItemState');

const str = (v) => (v == null ? '' : String(v));
const terminalItem = isTerminalOrderItem;

function issue(code, items, extra = {}) {
  return { code, count: Array.isArray(items) ? items.length : 0, items: items || [], ...extra };
}

async function auditSessionClosure({ deliveryGroupId, orderingSessionId }) {
  const groupId = str(deliveryGroupId);
  const sessionId = str(orderingSessionId);
  const blockers = [];
  const warnings = [];

  const session = sessionId
    ? await OrderingSession.findById(sessionId, '_id groupId seq openDate pickingStatus pickingConfirmedAt pickingStartedAt pickingCompletedAt').lean()
    : null;
  if (!session || str(session.groupId) !== groupId) {
    blockers.push(issue('session_identity_invalid', [{ sessionId, deliveryGroupId: groupId, actualGroupId: str(session?.groupId) }]));
    return { ok: false, blockers, warnings, session: session || null };
  }

  // Session ownership is canonical. Query ALL active tasks by sessionId first,
  // then validate their group. Otherwise a corrupted task with the correct
  // orderingSessionId but a wrong deliveryGroupId can block maybeCompleteSession()
  // while disappearing from this audit — the exact "can't close and can't see why"
  // failure this audit exists to prevent.
  const sessionActiveTasks = await PickingTask.find({
    orderingSessionId: sessionId,
    status: { $in: ['pending', 'locked'] },
  }, '_id productId deliveryGroupId blockId positionIndex status lockedBy lockedAt').sort({ blockId: 1, positionIndex: 1 }).lean();

  const active = sessionActiveTasks.filter((t) => str(t.deliveryGroupId) === groupId);
  const taskGroupMismatches = sessionActiveTasks.filter((t) => str(t.deliveryGroupId) !== groupId);
  if (active.length) blockers.push(issue('active_tasks', active.map((t) => ({
    taskId: str(t._id), productId: str(t.productId), blockId: t.blockId,
    positionIndex: t.positionIndex, status: t.status, lockedBy: str(t.lockedBy) || null,
    lockedAt: t.lockedAt || null,
  }))));

  const activeSupplementWaves = await SupplementWave.find({
    orderingSessionId: sessionId,
    status: { $in: SupplementWave.ACTIVE_STATUSES },
  }, '_id deliveryGroupId status openedAt frozenAt').sort({ openedAt: 1 }).lean();
  const supplementGroupMismatches = activeSupplementWaves.filter((wave) => str(wave.deliveryGroupId) !== groupId);
  const supplementForGroup = activeSupplementWaves.filter((wave) => str(wave.deliveryGroupId) === groupId);
  if (supplementForGroup.length) blockers.push(issue('active_supplement_waves', supplementForGroup.map((wave) => ({
    waveId: str(wave._id), status: wave.status, openedAt: wave.openedAt || null, frozenAt: wave.frozenAt || null,
  }))));
  if (supplementGroupMismatches.length) blockers.push(issue('session_supplement_group_mismatch', supplementGroupMismatches.map((wave) => ({
    waveId: str(wave._id), deliveryGroupId: str(wave.deliveryGroupId), expectedDeliveryGroupId: groupId, status: wave.status,
  }))));
  if (taskGroupMismatches.length) blockers.push(issue('session_task_group_mismatch', taskGroupMismatches.map((t) => ({
    taskId: str(t._id), productId: str(t.productId), deliveryGroupId: str(t.deliveryGroupId) || null,
    expectedDeliveryGroupId: groupId, blockId: t.blockId, positionIndex: t.positionIndex,
    status: t.status, lockedBy: str(t.lockedBy) || null, lockedAt: t.lockedAt || null,
  }))));

  const coverage = await auditSessionCoverage({ deliveryGroupId: groupId, orderingSessionId: sessionId });
  if (!coverage.ok) blockers.push(issue('coverage_gaps', coverage.gaps));

  // Session ownership is also canonical for Orders. Fetch by sessionId first so a
  // damaged buyerSnapshot.deliveryGroupId cannot make an Order invisible to the
  // end-of-session audit. `expired` is terminal at order level and intentionally
  // outside the delivery cycle.
  const sessionOrders = await Order.find({
    orderingSessionId: sessionId,
    status: { $ne: 'expired' },
  }, '_id orderNumber status buyerTelegramId shopId buyerSnapshot items').lean();

  // An unassigned seller's active Order is intentionally PARKED by
  // unassignSellerAndPark(): shopId + snapshot shop/group are cleared while the
  // old orderingSessionId is left as historical provenance until the seller is
  // assigned again. That is NOT corruption and must not block warehouse closure.
  const isParkedOrder = (o) => (
    !str(o.shopId) &&
    !str(o.buyerSnapshot?.shopId) &&
    !str(o.buyerSnapshot?.deliveryGroupId)
  );
  const parkedOrders = sessionOrders.filter(isParkedOrder);
  const operationalOrders = sessionOrders.filter((o) => !isParkedOrder(o));
  const orders = operationalOrders.filter((o) => str(o.buyerSnapshot?.deliveryGroupId) === groupId);
  const orderGroupMismatches = operationalOrders.filter((o) => str(o.buyerSnapshot?.deliveryGroupId) !== groupId);
  if (orderGroupMismatches.length) blockers.push(issue('session_order_group_mismatch', orderGroupMismatches.map((o) => ({
    orderId: str(o._id), orderNumber: o.orderNumber ?? null, status: o.status,
    buyerTelegramId: str(o.buyerTelegramId), shopName: o.buyerSnapshot?.shopName || '',
    deliveryGroupId: str(o.buyerSnapshot?.deliveryGroupId) || null,
    expectedDeliveryGroupId: groupId,
    livePositions: (o.items || []).filter((i) => !terminalItem(i)).length,
  }))));
  if (parkedOrders.length) warnings.push(issue('parked_session_orders', parkedOrders.map((o) => ({
    orderId: str(o._id), orderNumber: o.orderNumber ?? null, status: o.status,
    buyerTelegramId: str(o.buyerTelegramId),
    livePositions: (o.items || []).filter((i) => !terminalItem(i)).length,
  })), { blocking: false, scope: 'unassigned_seller' }));

  // Seller/order conflicts are a PRE-PICKING gate. start-session is authoritative
  // and blocks before task build. If one somehow appears after picking started it
  // is useful forensic information, but it must NEVER become a second closure gate.
  // Keep the canonical conflict definition: ACTIVE orders (new|in_progress) from
  // 2+ distinct buyers on one shop in THIS session.
  const ordersByShop = new Map();
  for (const order of orders.filter((o) => ['new', 'in_progress'].includes(o.status))) {
    const shopId = str(order.shopId || order.buyerSnapshot?.shopId);
    if (!shopId) continue;
    if (!ordersByShop.has(shopId)) ordersByShop.set(shopId, []);
    ordersByShop.get(shopId).push(order);
  }
  const shopOrderConflicts = [];
  for (const [shopId, rows] of ordersByShop.entries()) {
    const buyers = [...new Set(rows.map((o) => str(o.buyerTelegramId)).filter(Boolean))];
    if (buyers.length <= 1) continue;
    shopOrderConflicts.push({
      shopId,
      shopName: rows[0]?.buyerSnapshot?.shopName || '',
      buyerTelegramIds: buyers,
      orders: rows.map((o) => ({
        orderId: str(o._id), orderNumber: o.orderNumber ?? null, status: o.status,
        buyerTelegramId: str(o.buyerTelegramId),
      })),
    });
  }
  if (shopOrderConflicts.length) warnings.push(issue('shop_order_conflicts', shopOrderConflicts, {
    blocking: false,
    scope: 'pre_picking_conflict',
  }));

  const unterminated = [];
  for (const o of orders) {
    const positions = (o.items || []).filter((i) => !terminalItem(i)).map((i) => ({
      itemId: str(i._id), productId: str(i.productId) || null, name: i.name || '', quantity: Number(i.quantity) || 0,
    }));
    if (positions.length) unterminated.push({
      orderId: str(o._id), orderNumber: o.orderNumber ?? null, orderStatus: o.status,
      shopName: o.buyerSnapshot?.shopName || '', positions,
    });
  }
  if (unterminated.length) blockers.push(issue('unterminated_items', unterminated, {
    positionCount: unterminated.reduce((n, o) => n + o.positions.length, 0),
  }));

  // Foreign active tasks/orders are deliberately WARNINGS. They may be broken,
  // but last week's dirt must never stop this week's warehouse shift.
  const orphanTasks = await PickingTask.find({
    deliveryGroupId: groupId,
    status: { $in: ['pending', 'locked'] },
    orderingSessionId: { $ne: sessionId },
  }, '_id productId orderingSessionId blockId positionIndex status lockedBy lockedAt createdAt').sort({ createdAt: 1 }).lean();
  if (orphanTasks.length) {
    const pids = [...new Set(orphanTasks.map((t) => str(t.productId)).filter(Boolean))];
    const ownerSessionIds = [...new Set(orphanTasks.map((t) => str(t.orderingSessionId)).filter(Boolean))];
    const [products, ownerSessions] = await Promise.all([
      pids.length ? Product.find({ _id: { $in: pids } }, '_id brand model category orderNumber').lean() : [],
      ownerSessionIds.length ? OrderingSession.find({ _id: { $in: ownerSessionIds } }, '_id seq openDate pickingStatus').lean() : [],
    ]);
    const byPid = new Map(products.map((p) => [str(p._id), p]));
    const bySession = new Map(ownerSessions.map((row) => [str(row._id), row]));
    warnings.push(issue('orphan_tasks', orphanTasks.map((t) => {
      const p = byPid.get(str(t.productId));
      const owner = bySession.get(str(t.orderingSessionId));
      return {
        taskId: str(t._id), productId: str(t.productId),
        productTitle: p ? (p.brand || p.model || p.category || `#${p.orderNumber}`) : '',
        ownerSessionId: str(t.orderingSessionId) || null,
        ownerSession: owner ? {
          sessionId: str(owner._id), seq: owner.seq ?? null, openDate: owner.openDate || null, pickingStatus: owner.pickingStatus || null,
        } : null,
        blockId: t.blockId, positionIndex: t.positionIndex, status: t.status,
        lockedBy: str(t.lockedBy) || null, lockedAt: t.lockedAt || null, createdAt: t.createdAt || null,
      };
    })));
  }

  const staleOrders = await Order.find({
    'buyerSnapshot.deliveryGroupId': groupId,
    status: { $in: ['new', 'in_progress'] },
    orderingSessionId: { $ne: sessionId },
  }, '_id orderNumber status orderingSessionId buyerSnapshot items createdAt updatedAt').sort({ createdAt: 1 }).lean();
  if (staleOrders.length) warnings.push(issue('stale_orders', staleOrders.map((o) => ({
    orderId: str(o._id), orderNumber: o.orderNumber ?? null, status: o.status,
    ownerSessionId: str(o.orderingSessionId) || null, shopName: o.buyerSnapshot?.shopName || '',
    livePositions: (o.items || []).filter((i) => !terminalItem(i)).length,
    createdAt: o.createdAt || null, updatedAt: o.updatedAt || null,
  }))));

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    session: {
      sessionId, deliveryGroupId: groupId, seq: session.seq ?? null,
      openDate: session.openDate || null, pickingStatus: session.pickingStatus,
      pickingConfirmedAt: session.pickingConfirmedAt || null,
      pickingStartedAt: session.pickingStartedAt || null,
      pickingCompletedAt: session.pickingCompletedAt || null,
    },
  };
}

module.exports = { auditSessionClosure };
