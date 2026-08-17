'use strict';

/**
 * V48.S2 compensating command for a WRONG already-published ReceiptItem route.
 *
 * This is deliberately not unconfirm/delete. We preserve physical/history facts,
 * stop unfinished work through existing canonical mechanisms, then project the
 * corrected CURRENT/FUTURE route.
 */
const mongoose = require('mongoose');
const Receipt = require('../models/Receipt');
const ReceiptItem = require('../models/ReceiptItem');
const ReceiptItemLog = require('../models/ReceiptItemLog');
const ShopProduct = require('../models/ShopProduct');
const ProductVector = require('../models/ProductVector');
const SupplementWave = require('../models/SupplementWave');
const SupplementOffer = require('../models/SupplementOffer');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');
const {
  normalizeReceiptItemRouting,
  legacyDestinationForRouting,
  needsWarehouseProduct,
  needsStandaloneShopProduct,
  validateReceiptItemRouting,
} = require('../utils/receiptRouting');
const { publishArchiveProductOutcome } = require('./archiveProduct');
const { archiveProductInSession } = require('./archiveProductPrimitives');
const {
  ensureReceiptItemProduct,
  convertReceiptShopOwnedToWarehouseMirror,
} = require('./receiptRoutingArtifacts');
const { upsertShopOwnedFromReceiptItem, syncMirror } = require('../utils/upsertShopProduct');
const {
  withdrawReceiptItemFromActiveWaves,
  completeAffectedWaves,
  sourceSnapshotFromReceiptItem,
} = require('./supplementWaveService');
const { maybeCompleteSession } = require('../utils/sessionStatus');
const { getIO } = require('../socket');

function str(v) { return v == null ? '' : String(v); }
function sameRouting(a, b) {
  return ['warehouse', 'mandatory', 'supplement', 'mayNotReachAllShops', 'supplementDeliveryGroupId']
    .every((key) => str(a?.[key] ?? '') === str(b?.[key] ?? ''));
}

async function removeStandaloneShopArtifact(item, session) {
  if (!item.createdShopProductId) return;
  const id = item.createdShopProductId;
  await ProductVector.deleteMany({ shopProductId: id }).session(session);
  await ShopProduct.deleteOne({ _id: id, linkedProductId: null }).session(session);
  item.createdShopProductId = null;
}

async function removeArchivedWarehouseMirror(productId, session) {
  if (!productId) return;
  // A linked ShopProduct is a derived projection. The archived Product remains the
  // historical physical record; the mirror must not coexist with the corrected
  // standalone/current routing projection.
  await ShopProduct.deleteMany({ linkedProductId: productId }).session(session);
}

async function correctReceiptItemRouting({
  receiptId,
  itemId,
  nextRouting,
  actor = {},
  reason = 'routing_corrected',
}) {
  const rid = str(receiptId);
  const iid = str(itemId);
  return withLock(`receipt-item:${iid}:routing-correction`, async () => {
    const preReceipt = await Receipt.findById(rid).lean();
    const preItem = await ReceiptItem.findOne({ _id: iid, receiptId: rid }).lean();
    if (!preReceipt) throw appError('receipt_not_found');
    if (!preItem) throw appError('receipt_item_not_found');
    if (preItem.status !== 'confirmed') throw appError('receipt_item_not_confirmed_yet');

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

    // The archive/OOS reconciliation is composed INSIDE the same wider routing
    // transaction below. A process crash can therefore never leave Product=archived
    // while ReceiptItem.routing still points at the old warehouse route.
    let archivedProductId = null;
    let archiveOutcome = null;

    const mongoSession = await mongoose.connection.startSession();
    let updatedItem = null;
    let affectedWaveIds = [];
    let fulfilledShopIds = [];
    let sessionIdsToReevaluate = [];
    let productForMirror = null;
    let shopProductForEmbedding = null;
    try {
      await mongoSession.withTransaction(async () => {
        const receipt = await Receipt.findById(rid).session(mongoSession);
        const item = await ReceiptItem.findOne({ _id: iid, receiptId: rid }).session(mongoSession);
        if (!receipt) throw appError('receipt_not_found');
        if (!item) throw appError('receipt_item_not_found');
        if (item.status !== 'confirmed') throw appError('receipt_item_not_confirmed_yet');

        const livePrevious = normalizeReceiptItemRouting(item, receipt);
        if (!sameRouting(livePrevious, previousRouting)) throw appError('receipt_route_locked');

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

        // Any Product becomes obsolete when the corrected route is non-warehouse.
        // This also cleans legacy supplement-only rows that used to create a fake
        // technical Product even though their business route was never warehouse.
        if (!normalizedNext.warehouse && item.createdProductId) {
          archivedProductId = str(item.createdProductId);
          archiveOutcome = await archiveProductInSession(item.createdProductId, {
            session: mongoSession,
            reason: 'receipt_routing_correction',
            actor: {
              by: str(actor.by),
              byName: str(actor.byName),
              byRole: str(actor.byRole || 'warehouse'),
            },
            now: new Date(),
          });
        }

        // Remove current non-warehouse catalog artifact when the corrected route no
        // longer owns it. Full audit remains in ReceiptItemLog.
        if (item.createdShopProductId && !needsStandaloneShopProduct(normalizedNext)) {
          await removeStandaloneShopArtifact(item, mongoSession);
        }
        if (archivedProductId) {
          await removeArchivedWarehouseMirror(archivedProductId, mongoSession);
          item.createdProductId = null;
          item.stockApplied = false;
        }

        item.routingVersion = 1;
        item.routing = {
          ...normalizedNext,
          supplementDeliveryGroupId: normalizedNext.supplement
            ? (livePrevious.supplement ? livePrevious.supplementDeliveryGroupId : null)
            : null,
        };
        item.destination = legacyDestinationForRouting(item.routing);

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
            { receiptItemId: item._id, waveId: { $ne: null }, itemStatus: 'active' },
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
      });
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

    await completeAffectedWaves(affectedWaveIds, actor).catch(() => {});
    if (archiveOutcome?.changed) {
      await publishArchiveProductOutcome(archiveOutcome, {
        reason: 'receipt_routing_correction',
        notifyBuyers: false,
      }).catch(() => {});
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
        archivedProductId,
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
  }, { ttlMs: 60_000, waitMs: 15_000 });
}

module.exports = { correctReceiptItemRouting };
