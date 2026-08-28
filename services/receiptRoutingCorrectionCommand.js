'use strict';

/**
 * V48.S3 compensating command for a WRONG already-published ReceiptItem route.
 *
 * This is deliberately not unconfirm/delete. We preserve physical/history facts,
 * stop unfinished work through existing canonical mechanisms, then project the
 * corrected CURRENT/FUTURE route.
 */
const mongoose = require('mongoose');
const Receipt = require('../models/Receipt');
const ReceiptItem = require('../models/ReceiptItem');
const ReceiptItemLog = require('../models/ReceiptItemLog');
const Product = require('../models/Product');
const ShopProduct = require('../models/ShopProduct');
const ProductVector = require('../models/ProductVector');
const SupplementWave = require('../models/SupplementWave');
const SupplementOffer = require('../models/SupplementOffer');
const { withLock } = require('../utils/lock');
const { withProductOrderNumberLock } = require('./productOrderNumber');
const { appError } = require('../utils/errors');
const {
  normalizeReceiptItemRouting,
  legacyDestinationForRouting,
  needsWarehouseProduct,
  needsStandaloneShopProduct,
  validateReceiptItemRouting,
} = require('../utils/receiptRouting');
const {
  ensureReceiptItemProduct,
  convertReceiptShopOwnedToWarehouseMirror,
  convertReceiptWarehouseToShopOwned,
} = require('./receiptRoutingArtifacts');
const { upsertShopOwnedFromReceiptItem, syncMirror } = require('../utils/upsertShopProduct');
const { describeItemUsage } = require('./receiptSync');
const {
  withdrawReceiptItemFromActiveWaves,
  sourceSnapshotFromReceiptItem,
} = require('./supplementWaveService');
const {
  ACTIVE_ITEM_STATUSES,
  ITEM_RELATION_STATUS,
  RECEIPT_ITEM_SUPPLEMENT_STATE,
  deriveReceiptItemSupplementState,
  findActiveReceiptItemSupplementOffer,
} = require('../utils/supplementState');
const { maybeCompleteSession } = require('../utils/sessionStatus');
const { getIO } = require('../socket');

function str(v) { return v == null ? '' : String(v); }
function sameRouting(a, b) {
  return ['warehouse', 'mandatory', 'supplement', 'mayNotReachAllShops', 'supplementDeliveryGroupId']
    .every((key) => str(a?.[key] ?? '') === str(b?.[key] ?? ''));
}

async function supplementLifecycleForItem(item, receipt, session = null) {
  let query = SupplementOffer.find(
    { receiptItemId: item._id, waveId: { $ne: null } },
    'waveId deliveryGroupId status itemStatus openedAt frozenAt completedAt revisionHistory',
  );
  if (session) query = query.session(session);
  const offers = await query.lean();
  const state = deriveReceiptItemSupplementState({
    offers,
    routingSupplement: normalizeReceiptItemRouting(item, receipt).supplement,
    receiptCompleted: receipt.status === 'completed',
  });
  return {
    offers,
    state,
    activeOffer: findActiveReceiptItemSupplementOffer(offers, state),
  };
}

async function assertRoutingCorrectionAllowed({ item, receipt, nextRouting, session = null }) {
  const previous = normalizeReceiptItemRouting(item, receipt);
  if (sameRouting(previous, nextRouting)) return { previous, supplementState: null };

  const lifecycle = await supplementLifecycleForItem(item, receipt, session);

  // Seller input is still live: the receiving document is not allowed to rewrite
  // the route underneath shops. Staff must first freeze/close the supplement.
  // FROZEN is intentionally different: seller writes are closed, so warehouse may
  // correct the route; removing supplement then annuls the current revision.
  if (lifecycle.state === RECEIPT_ITEM_SUPPLEMENT_STATE.OPEN) {
    throw appError('receipt_supplement_route_open');
  }

  // COMPLETED is an immutable historical fact. The worker may still change
  // independent future routing (for example add Warehouse remainder), but may
  // not erase or recreate the Supplement dimension through the receipt editor.
  if (lifecycle.state === RECEIPT_ITEM_SUPPLEMENT_STATE.COMPLETED
      && Boolean(nextRouting.supplement) !== Boolean(previous.supplement)) {
    throw appError('receipt_supplement_already_completed');
  }

  if (previous.warehouse && !nextRouting.warehouse && item.createdProductId) {
    const usage = await describeItemUsage(item, { session, mode: 'warehouse_detach' });
    if (usage.inUse) throw appError('receipt_item_in_use', { reasons: usage.reasons.join('; ') });
  }

  return { previous, supplementState: lifecycle.state, activeOffer: lifecycle.activeOffer };
}

async function preflightReceiptItemRoutingCorrection({ receiptId, itemId, nextRouting, expectedRoutingRevision = null }) {
  const rid = str(receiptId);
  const iid = str(itemId);
  const receipt = await Receipt.findById(rid).lean();
  const item = await ReceiptItem.findOne({ _id: iid, receiptId: rid }).lean();
  if (!receipt) throw appError('receipt_not_found');
  if (!item) throw appError('receipt_item_not_found');
  if (item.status !== 'confirmed') throw appError('receipt_item_not_confirmed_yet');
  if (expectedRoutingRevision !== null
      && Number(item.routingRevision || 0) !== Number(expectedRoutingRevision)) {
    throw appError('receipt_route_stale', { currentRevision: Number(item.routingRevision || 0) });
  }

  const previous = normalizeReceiptItemRouting(item, receipt);
  const requested = {
    warehouse: !!nextRouting?.warehouse,
    mandatory: !!nextRouting?.mandatory,
    supplement: !!nextRouting?.supplement,
    mayNotReachAllShops: !!nextRouting?.mayNotReachAllShops,
    supplementDeliveryGroupId: previous.supplement && nextRouting?.supplement
      ? previous.supplementDeliveryGroupId
      : null,
  };
  const check = validateReceiptItemRouting(requested, { allowSupplementWithoutGroup: true });
  if (!check.ok) {
    if (check.reason === 'mandatory_and_supplement') throw appError('receipt_route_conflict');
    if (check.reason === 'may_not_reach_without_mandatory') throw appError('receipt_route_warning_requires_mandatory');
    if (check.reason === 'may_not_reach_with_warehouse') throw appError('receipt_route_warning_with_warehouse');
    throw appError('receipt_route_required');
  }
  await assertRoutingCorrectionAllowed({ item, receipt, nextRouting: check.routing });
  return { item, receipt, previousRouting: previous, nextRouting: check.routing };
}

async function correctReceiptItemRouting({
  receiptId,
  itemId,
  nextRouting,
  actor = {},
  reason = 'routing_corrected',
  expectedRoutingRevision = null,
}) {
  const rid = str(receiptId);
  const iid = str(itemId);
  return withLock(`receipt-item:${iid}:routing-correction`, async () => {
    const preReceipt = await Receipt.findById(rid).lean();
    const preItem = await ReceiptItem.findOne({ _id: iid, receiptId: rid }).lean();
    if (!preReceipt) throw appError('receipt_not_found');
    if (!preItem) throw appError('receipt_item_not_found');
    if (preItem.status !== 'confirmed') throw appError('receipt_item_not_confirmed_yet');
    if (expectedRoutingRevision !== null
        && Number(preItem.routingRevision || 0) !== Number(expectedRoutingRevision)) {
      throw appError('receipt_route_stale', { currentRevision: Number(preItem.routingRevision || 0) });
    }

    const previousRouting = normalizeReceiptItemRouting(preItem, preReceipt);
    const requested = {
      warehouse: !!nextRouting?.warehouse,
      mandatory: !!nextRouting?.mandatory,
      supplement: !!nextRouting?.supplement,
      mayNotReachAllShops: !!nextRouting?.mayNotReachAllShops,
      // Group belongs to Wave publication, not direct route editing.
      supplementDeliveryGroupId: previousRouting.supplement && nextRouting?.supplement
        ? previousRouting.supplementDeliveryGroupId
        : null,
    };
    const check = validateReceiptItemRouting(requested, { allowSupplementWithoutGroup: true });
    if (!check.ok) {
      if (check.reason === 'mandatory_and_supplement') throw appError('receipt_route_conflict');
      if (check.reason === 'may_not_reach_without_mandatory') throw appError('receipt_route_warning_requires_mandatory');
      if (check.reason === 'may_not_reach_with_warehouse') throw appError('receipt_route_warning_with_warehouse');
      throw appError('receipt_route_required');
    }
    const normalizedNext = check.routing;
    if (sameRouting(previousRouting, normalizedNext)) return { item: preItem, changed: false, affectedWaveIds: [] };

    const executeCorrection = async () => {
    const mongoSession = await mongoose.connection.startSession();
    let updatedItem = null;
    let affectedWaveIds = [];
    let fulfilledShopIds = [];
    let sessionIdsToReevaluate = [];
    let productForMirror = null;
    let shopProductForEmbedding = null;
    try {
      await withProductOrderNumberLock(() => mongoSession.withTransaction(async () => {
        const receipt = await Receipt.findById(rid).session(mongoSession);
        const item = await ReceiptItem.findOne({ _id: iid, receiptId: rid }).session(mongoSession);
        if (!receipt) throw appError('receipt_not_found');
        if (!item) throw appError('receipt_item_not_found');
        if (item.status !== 'confirmed') throw appError('receipt_item_not_confirmed_yet');

        const livePrevious = normalizeReceiptItemRouting(item, receipt);
        if (expectedRoutingRevision !== null
            && Number(item.routingRevision || 0) !== Number(expectedRoutingRevision)) {
          throw appError('receipt_route_stale', { currentRevision: Number(item.routingRevision || 0) });
        }
        if (!sameRouting(livePrevious, previousRouting)) throw appError('receipt_route_stale', { currentRevision: Number(item.routingRevision || 0) });

        await assertRoutingCorrectionAllowed({
          item,
          receipt,
          nextRouting: normalizedNext,
          session: mongoSession,
        });

        // OPEN supplement is rejected above. Once FROZEN, seller writes are closed
        // and warehouse may correct the route. Removing supplement is an explicit
        // compensation: every request in the current revision is annulled and the
        // publication is withdrawn. COMPLETED history is immutable and untouched.
        if (livePrevious.supplement && !normalizedNext.supplement) {
          const withdrawal = await withdrawReceiptItemFromActiveWaves({
            receiptItemId: item._id,
            actor,
            reason,
            session: mongoSession,
          });
          affectedWaveIds = withdrawal.waveIds;
          fulfilledShopIds = withdrawal.alreadyFulfilledShopIds;
        }

        const warehouseProductIdToRemove = livePrevious.warehouse && !normalizedNext.warehouse
          ? item.createdProductId
          : null;

        item.routingVersion = 1;
        item.routing = {
          ...normalizedNext,
          supplementDeliveryGroupId: normalizedNext.supplement
            ? (livePrevious.supplement ? livePrevious.supplementDeliveryGroupId : null)
            : null,
        };
        item.destination = legacyDestinationForRouting(item.routing);
        item.routingRevision = Number(item.routingRevision || 0) + 1;

        if (!item.routing.supplement) {
          item.supplementBatchVersion = 0;
          item.supplementPublishRequestedAt = null;
        } else if (!livePrevious.supplement) {
          item.supplementBatchVersion = 2;
          item.supplementPublishRequestedAt = null;
        }

        item.routingCorrection = {
          correctedAt: new Date(),
          correctedBy: str(actor.by),
          reason: str(reason),
          alreadyFulfilledShopIds: [...new Set(fulfilledShopIds)],
          sourceWaveIds: affectedWaveIds,
        };
        await item.save({ session: mongoSession });

        // Removing Warehouse is a technical projection rollback ONLY while the
        // Product never entered physical/order/picking life. It is NOT Archive.
        // Preserve the catalogue identity by converting the warehouse mirror into
        // the receipt-owned ShopProduct used by Mandatory/Supplement-only routes.
        if (warehouseProductIdToRemove) {
          const product = await Product.findById(warehouseProductIdToRemove).session(mongoSession);
          if (product) {
            await convertReceiptWarehouseToShopOwned(item, product, mongoSession);
          } else {
            item.createdProductId = null;
            item.stockApplied = false;
            await item.save({ session: mongoSession });
          }
        }

        if (needsWarehouseProduct(item.routing)) {
          const product = await ensureReceiptItemProduct(item, mongoSession, receipt);
          if (product) {
            await convertReceiptShopOwnedToWarehouseMirror(item, product, mongoSession);
            productForMirror = product;
          }
        } else if (needsStandaloneShopProduct(item.routing)) {
          const sp = await upsertShopOwnedFromReceiptItem(item.toObject(), { session: mongoSession });
          if (sp) {
            item.createdShopProductId = sp._id;
            await item.save({ session: mongoSession });
            shopProductForEmbedding = sp;
          }
        }

        // If the item REMAINS a supplement while its warehouse flag changes, the
        // already-open Wave must follow the corrected artifact shape. Standalone
        // supplement is a first-class state (productId=null); supplement+warehouse
        // points to the real Product so physical location and same-session ordinary
        // exclusion stay correct. The snapshot is refreshed from the durable
        // ReceiptItem rather than depending on the Product foreign key.
        if (item.routing.supplement) {
          await SupplementOffer.updateMany(
            { receiptItemId: item._id, waveId: { $ne: null }, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: { $in: ACTIVE_ITEM_STATUSES } },
            {
              $set: {
                productId: item.createdProductId || null,
                sourceSnapshot: sourceSnapshotFromReceiptItem(item),
              },
            },
            { session: mongoSession },
          );
        }

        if (affectedWaveIds.length) {
          const waves = await SupplementWave.find(
            { _id: { $in: affectedWaveIds } },
            'orderingSessionId',
          ).session(mongoSession).lean();
          sessionIdsToReevaluate = [...new Set(waves.map((w) => str(w.orderingSessionId)).filter(Boolean))];
        }
        updatedItem = item.toObject();
      }));
    } finally {
      await mongoSession.endSession();
    }

    // Derived mirror was committed transactionally above. Embedding is intentionally
    // outside this command transaction like ordinary receipt confirmation.
    if (productForMirror) {
      try { await syncMirror(productForMirror); } catch (_) {}
    }
    if (shopProductForEmbedding) {
      try { require('../utils/shopProductEmbedding').embedShopProductAsync(shopProductForEmbedding, 'routing-correction'); } catch (_) {}
    }

    if (affectedWaveIds.length) {
      try {
        const waves = await SupplementWave.find({ _id: { $in: affectedWaveIds } }).lean();
        await require('./supplementNotify').notifyWaves(waves, 'cancelled');
      } catch (_) {}
    }
    for (const sessionId of sessionIdsToReevaluate) await maybeCompleteSession(sessionId).catch(() => {});

    await ReceiptItemLog.create({
      receiptId: rid,
      itemId: iid,
      itemName: preItem.name || '',
      action: 'routing_change',
      actor: {
        telegramId: str(actor.by),
        firstName: str(actor.byName),
        lastName: '',
      },
      changes: [{ field: 'routing', label: 'Маршрут', from: previousRouting, to: normalizedNext }],
      meta: {
        correction: true,
        reason,
        affectedWaveIds,
        alreadyFulfilledShopIds: fulfilledShopIds,
      },
    }).catch(() => {});

    try {
      const io = getIO();
      io?.to(`receipt_${rid}`).emit('receipt_item_updated', updatedItem);
      io?.emit('receipt_supplement_batch_changed');
      io?.emit('incoming_updated');
      for (const waveId of affectedWaveIds) io?.emit('supplement_wave_changed', { waveId });
    } catch (_) {}

    return { item: updatedItem, changed: true, affectedWaveIds, alreadyFulfilledShopIds: fulfilledShopIds };
    };

    // Receipt routing and physical Block/archive commands share this Product lock.
    // The precheck is repeated inside the transaction while the lock is held, so
    // a product cannot be shelved/archived between "safe to detach" and deletion.
    if (preItem.createdProductId) {
      return withLock(
        `product:${str(preItem.createdProductId)}:physical-lifecycle`,
        executeCorrection,
        { ttlMs: 60_000, waitMs: 15_000 },
      );
    }
    return executeCorrection();
  }, { ttlMs: 60_000, waitMs: 15_000 });
}

module.exports = { correctReceiptItemRouting, preflightReceiptItemRoutingCorrection, assertRoutingCorrectionAllowed };
