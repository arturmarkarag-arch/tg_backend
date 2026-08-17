'use strict';

/**
 * Read-only projection of supplement warehouse work into the existing «Зміна» UI.
 *
 * IMPORTANT: supplement work and ordinary PickingTask work are different units.
 * This read model never merges their counters; the controller only merges the
 * chronological history rows for presentation.
 */
const SupplementRequest = require('../../models/SupplementRequest');
const SupplementOffer = require('../../models/SupplementOffer');
const OrderingSession = require('../../models/OrderingSession');
const { loadProductsFor, productView } = require('../supplementOffers');
const { buildShopNumberLookup } = require('../../utils/shopNumbering');

function str(v) { return v == null ? '' : String(v); }

async function getSupplementShiftSummary({ orderingSessionId, deliveryGroupId }) {
  if (!orderingSessionId || !deliveryGroupId) {
    return { totalPacked: 0, lastActivity: null, workers: [] };
  }

  const rows = await SupplementRequest.aggregate([
    {
      $match: {
        orderingSessionId: str(orderingSessionId),
        deliveryGroupId: str(deliveryGroupId),
        packed: true,
        packedBy: { $nin: [null, ''] },
      },
    },
    {
      $group: {
        _id: '$packedBy',
        name: { $last: '$packedByName' },
        supplementPackedCount: { $sum: 1 },
        lastPackedAt: { $max: '$packedAt' },
      },
    },
  ]);

  const totalPacked = rows.reduce((sum, row) => sum + Number(row.supplementPackedCount || 0), 0);
  const lastActivity = rows.reduce((latest, row) => {
    if (!row.lastPackedAt) return latest;
    if (!latest || new Date(row.lastPackedAt) > new Date(latest)) return row.lastPackedAt;
    return latest;
  }, null);

  return {
    totalPacked,
    lastActivity,
    workers: rows.map((row) => ({
      telegramId: str(row._id),
      name: row.name || '',
      supplementPackedCount: Number(row.supplementPackedCount || 0),
      lastPackedAt: row.lastPackedAt || null,
    })),
  };
}

async function getSupplementWorkerHistory({
  orderingSessionId,
  deliveryGroupId,
  workerTelegramId,
  fetchLimit = 75,
}) {
  if (!orderingSessionId || !deliveryGroupId || !workerTelegramId) return { total: 0, items: [] };

  const match = {
    orderingSessionId: str(orderingSessionId),
    deliveryGroupId: str(deliveryGroupId),
    packed: true,
    packedBy: str(workerTelegramId),
  };

  const [total, requests, sessionMeta] = await Promise.all([
    SupplementRequest.countDocuments(match),
    SupplementRequest.find(
      match,
      'offerId shopId shopName quantity packed packedBy packedByName packedAt',
    )
      .sort({ packedAt: -1, _id: -1 })
      .limit(Math.max(1, fetchLimit))
      .lean(),
    OrderingSession.findById(orderingSessionId, 'shopNumbers').lean(),
  ]);

  if (!requests.length) return { total, items: [] };

  const offers = await SupplementOffer.find(
    { _id: { $in: [...new Set(requests.map((row) => row.offerId))] } },
    '_id waveId receiptItemId productId sourceSnapshot deliveryGroupId orderingSessionId',
  ).lean();
  const offerById = new Map(offers.map((offer) => [str(offer._id), offer]));
  const productMap = await loadProductsFor(offers);
  const shopLookup = buildShopNumberLookup(sessionMeta?.shopNumbers);

  const items = requests.map((request) => {
    const offer = offerById.get(str(request.offerId));
    const product = offer ? productView(productMap.get(str(offer.productId)), offer) : { productId: null, title: 'Товар', imageUrl: null };
    const shopNumber = (request.shopId != null ? shopLookup.byId.get(str(request.shopId)) : undefined)
      ?? shopLookup.byName.get(str(request.shopName || ''))
      ?? null;

    return {
      kind: 'supplement',
      taskId: `supplement:${str(request._id)}`,
      requestId: str(request._id),
      offerId: offer ? str(offer._id) : null,
      waveId: offer?.waveId ? str(offer.waveId) : null,
      productId: product.productId || null,
      productTitle: product.title || 'Товар',
      imageUrl: product.imageUrl || null,
      blockId: null,
      positionIndex: null,
      status: 'completed',
      completionReason: 'supplement_packed',
      packedCount: 1,
      itemCount: 1,
      workerPackedCount: 1,
      shops: [{
        orderId: '',
        shopId: request.shopId ? str(request.shopId) : null,
        shopName: request.shopName || '—',
        shopNumber,
        sellerName: '',
        quantity: Number(request.quantity || 0),
        packed: true,
        packedBy: str(request.packedBy),
        packedByName: request.packedByName || '',
        packedAt: request.packedAt || null,
        markedByWorker: true,
      }],
      isActiveForWorker: false,
      completedByWorker: true,
      at: request.packedAt || null,
    };
  });

  return { total, items };
}

module.exports = {
  getSupplementShiftSummary,
  getSupplementWorkerHistory,
};
