'use strict';

/**
 * Lazy product disclosure for one shop in the CURRENT ordering session.
 * Query-only; uses the same active-line semantics as the shop-status read model.
 */
const DeliveryGroup = require('../../models/DeliveryGroup');
const Shop = require('../../models/Shop');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const { appError } = require('../../utils/errors');
const { normalizeDeliveryGroup } = require('../../utils/deliveryGroupHelpers');
const { findCurrentSessionId } = require('../../utils/getOrCreateSession');
const { liveItem } = require('./currentSessionShopStatusReadModel');

function normalizePagination({ limit, offset }) {
  return {
    limit: Math.min(48, Math.max(1, Number.parseInt(limit, 10) || 24)),
    offset: Math.max(0, Number.parseInt(offset, 10) || 0),
  };
}

async function buildCurrentSessionShopProductsReadModel({ groupId, shopId, limit, offset }) {
  const page = normalizePagination({ limit, offset });
  const group = normalizeDeliveryGroup(await DeliveryGroup.findById(groupId).lean());
  if (!group) throw appError('group_not_found');

  const shop = await Shop.findOne({
    _id: shopId,
    deliveryGroupId: String(group._id),
    isActive: true,
  }).select('_id').lean();
  if (!shop) throw appError('shop_not_found');

  const currentSessionId = await findCurrentSessionId(String(group._id), group.orderingSchedule);
  if (!currentSessionId) {
    return { items: [], total: 0, ...page, hasMore: false };
  }

  const shopObjectId = shop._id;
  const shopIdString = String(shop._id);
  const orders = await Order.find({
    $or: [
      { shopId: shopObjectId },
      { 'buyerSnapshot.shopId': shopObjectId },
      { 'buyerSnapshot.shopId': shopIdString },
    ],
    orderingSessionId: currentSessionId,
    status: { $in: ['new', 'in_progress'] },
  }).select('items').lean();

  const productIds = [];
  const seen = new Set();
  for (const order of orders) {
    for (const item of order.items || []) {
      if (!liveItem(item)) continue;
      const id = String(item.productId);
      if (seen.has(id)) continue;
      seen.add(id);
      productIds.push(item.productId);
    }
  }
  if (!productIds.length) return { items: [], total: 0, ...page, hasMore: false };

  const productFilter = { _id: { $in: productIds } };
  const [total, products] = await Promise.all([
    Product.countDocuments(productFilter),
    Product.find(productFilter)
      .select('name brand model category imageUrls originalImageUrl localImageUrl orderNumber status')
      .sort({ orderNumber: 1, _id: 1 })
      .skip(page.offset)
      .limit(page.limit)
      .lean(),
  ]);

  return {
    items: products.map((product) => ({
      _id: product._id,
      name: product.name || product.brand || product.model || product.category || '',
      imageUrls: product.imageUrls || [],
      originalImageUrl: product.originalImageUrl || '',
      localImageUrl: product.localImageUrl || '',
      status: product.status || '',
    })),
    total,
    ...page,
    hasMore: page.offset + products.length < total,
  };
}

module.exports = {
  buildCurrentSessionShopProductsReadModel,
  normalizePagination,
};
