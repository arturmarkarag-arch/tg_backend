'use strict';

const Order = require('../models/Order');
const Shop = require('../models/Shop');
const { appError } = require('../utils/errors');
const { getOrderOwnershipState } = require('../utils/orderOwnership');
const {
  ACTIVE_ORDER_STATUSES,
  PARKED_ORDER_STATUSES,
} = require('../utils/orderStatus');

const ASSIGNMENT_RELEVANT_STATUSES = Object.freeze([
  ...ACTIVE_ORDER_STATUSES,
  ...PARKED_ORDER_STATUSES,
]);

function str(value) {
  return value == null ? '' : String(value);
}

/**
 * Operational Shop identity of an Order.
 *
 * Legacy rows may have only buyerSnapshot.shopId. That shape is still readable.
 * If BOTH fields exist they must agree; a disagreement is live ownership
 * corruption, not something assignment code may guess around.
 */
function getOrderShopIdentity(order) {
  const topLevel = str(order?.shopId);
  const snapshot = str(order?.buyerSnapshot?.shopId);
  return {
    shopId: topLevel || snapshot || '',
    topLevelShopId: topLevel,
    snapshotShopId: snapshot,
    consistent: !(topLevel && snapshot && topLevel !== snapshot),
  };
}

async function classifySellerAssignmentOrders({ sellerTelegramId, session = null, now = new Date() }) {
  const tid = str(sellerTelegramId).trim();
  if (!tid) return [];

  let query = Order.find({
    buyerTelegramId: tid,
    status: { $in: ASSIGNMENT_RELEVANT_STATUSES },
  }).sort({ createdAt: 1, _id: 1 });
  if (session) query = query.session(session);

  const orders = await query;
  const out = [];
  for (const order of orders) {
    const ownership = await getOrderOwnershipState(order, { session, now });
    out.push({
      order,
      ownership,
      frozen: Boolean(ownership?.frozen),
      active: ACTIVE_ORDER_STATUSES.includes(str(order.status)),
      parked: PARKED_ORDER_STATUSES.includes(str(order.status)),
      shop: getOrderShopIdentity(order),
      orderingSessionId: str(order.orderingSessionId),
    });
  }
  return out;
}

function invariantError(kind, rows = []) {
  const orderIds = rows.map((row) => str(row?.order?._id)).filter(Boolean);
  const sessionIds = rows.map((row) => row?.orderingSessionId).filter(Boolean);
  const shopIds = rows.map((row) => row?.shop?.shopId).filter(Boolean);
  return appError('seller_order_assignment_invariant', {
    kind,
    orderIds,
    orderingSessionIds: [...new Set(sessionIds)],
    shopIds: [...new Set(shopIds)],
  });
}

function assertTransferableRowsMatchAssignment(rows, currentShopId) {
  const current = str(currentShopId);

  // Historical/frozen rows are intentionally excluded before this function is
  // called. They are visibility-only and MUST NOT block today's assignment.
  for (const row of rows) {
    if (!row.shop.consistent) throw invariantError('order_shop_snapshot_mismatch', [row]);

    if (current) {
      if (row.parked) throw invariantError('parked_order_while_seller_assigned', [row]);
      if (!row.shop.shopId || row.shop.shopId !== current) {
        throw invariantError('transferable_order_shop_mismatch', [row]);
      }
    } else {
      // Canonical unassigned shape is new_unassign with preserved historical
      // shop/session ownership. Pre-new_unassign rows with no Shop are accepted
      // ONLY by the resolver as a one-shot compatibility candidate; post-write
      // invariant validation requires the canonical parked status.
      if (!row.parked) throw invariantError('active_order_while_seller_unassigned', [row]);
    }
  }

  if (rows.length > 1) throw invariantError('multiple_transferable_orders', rows);
}

/**
 * Resolve the ONE Order that may follow a seller assignment.
 *
 * Ordinary resolution is SESSION-AGNOSTIC: it discovers actual non-terminal
 * Orders by seller identity and classifies ownership. CURRENT/NEXT is never a
 * source lookup rule. Frozen historical rows are ignored for transfer and never
 * block a later assignment.
 *
 * `expectedOrderingSessionId` is reserved for the explicit conflict-repair flow:
 * staff intentionally selects one exact current-session Order and may opt into a
 * frozen ownership repair. That is a repair precondition, not ordinary routing.
 */
async function resolveSellerAssignmentOrder({
  seller,
  session = null,
  now = new Date(),
  expectedOrderingSessionId = null,
  allowFrozenOverride = false,
} = {}) {
  const sellerTelegramId = str(seller?.telegramId).trim();
  if (!sellerTelegramId) throw appError('user_not_found');
  const currentShopId = str(seller?.shopId);

  const rows = await classifySellerAssignmentOrders({ sellerTelegramId, session, now });

  if (expectedOrderingSessionId) {
    const expected = str(expectedOrderingSessionId);
    const exact = rows.filter((row) => (
      row.active
      && row.orderingSessionId === expected
      && (!currentShopId || row.shop.shopId === currentShopId)
    ));

    if (exact.length !== 1) throw appError('ordering_session_changed');
    const selected = exact[0];
    if (!selected.shop.consistent) throw invariantError('order_shop_snapshot_mismatch', [selected]);

    return {
      transferOrder: (!selected.frozen || allowFrozenOverride) ? selected.order : null,
      transferOwnership: selected.ownership,
      stayedOrder: (selected.frozen && !allowFrozenOverride) ? selected.order : null,
      frozenOrders: rows.filter((row) => row.frozen).map((row) => row.order),
      rows,
      selected,
    };
  }

  const transferable = rows.filter((row) => !row.frozen);

  if (currentShopId) {
    assertTransferableRowsMatchAssignment(transferable, currentShopId);
  } else {
    // Compatibility with pre-new_unassign builds: an unassigned seller may have
    // one old active row whose ownership fields were destructively nulled. Let
    // assignment recover it, but never allow an active row still owned by a Shop
    // to be guessed as "the" seller cart.
    const canonicalParked = transferable.filter((row) => row.parked);
    const legacyNullOwned = transferable.filter((row) => (
      row.active
      && !row.shop.shopId
      && row.shop.consistent
    ));
    const invalid = transferable.filter((row) => !canonicalParked.includes(row) && !legacyNullOwned.includes(row));
    if (invalid.length) throw invariantError('unassigned_seller_live_order_mismatch', invalid);

    const recoverable = [...canonicalParked, ...legacyNullOwned];
    if (recoverable.length > 1) throw invariantError('multiple_transferable_orders', recoverable);

    const selected = recoverable[0] || null;
    return {
      transferOrder: selected?.order || null,
      transferOwnership: selected?.ownership || null,
      stayedOrder: null,
      frozenOrders: rows.filter((row) => row.frozen).map((row) => row.order),
      rows,
      selected,
    };
  }

  const selected = transferable[0] || null;
  const currentShopFrozen = rows
    .filter((row) => row.frozen && row.shop.consistent && row.shop.shopId === currentShopId)
    .map((row) => row.order);

  return {
    transferOrder: selected?.order || null,
    transferOwnership: selected?.ownership || null,
    // Audit/UI compatibility: "stayed with shop" means the seller has historical
    // frozen ownership on the Shop. There may be many historical rows; assignment
    // never chooses among them for mutation.
    stayedOrder: currentShopFrozen[0] || null,
    frozenOrders: rows.filter((row) => row.frozen).map((row) => row.order),
    rows,
    selected,
  };
}

/**
 * Fail-closed post-write guard for CURRENT assignment state.
 *
 * It intentionally validates ONLY non-frozen rows. Old/frozen Orders may keep a
 * different Shop forever and must never block a new week or a new assignment.
 */
async function assertSellerAssignmentOrderInvariant({
  sellerTelegramId,
  currentShopId = null,
  session = null,
  now = new Date(),
} = {}) {
  const rows = await classifySellerAssignmentOrders({ sellerTelegramId, session, now });
  const transferable = rows.filter((row) => !row.frozen);
  assertTransferableRowsMatchAssignment(transferable, currentShopId);

  const current = str(currentShopId);
  if (current && transferable.length === 1) {
    let shopQuery = Shop.findById(current, 'deliveryGroupId');
    if (session) shopQuery = shopQuery.session(session);
    const shop = await shopQuery.lean();
    const expectedGroupId = str(shop?.deliveryGroupId);
    if (!shop || !expectedGroupId) {
      throw invariantError('assigned_shop_topology_missing', transferable);
    }
    const row = transferable[0];
    const orderGroupId = str(row.ownership?.session?.groupId);
    if (!row.orderingSessionId || !orderGroupId || orderGroupId !== expectedGroupId) {
      throw invariantError('transferable_order_session_group_mismatch', [row]);
    }
  }

  return { ok: true, transferableCount: transferable.length };
}

module.exports = {
  ASSIGNMENT_RELEVANT_STATUSES,
  getOrderShopIdentity,
  classifySellerAssignmentOrders,
  resolveSellerAssignmentOrder,
  assertSellerAssignmentOrderInvariant,
};
