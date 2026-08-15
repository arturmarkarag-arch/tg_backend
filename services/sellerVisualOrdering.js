'use strict';

/**
 * DB/cache wrapper for seller-catalog visual ordering.
 * Never writes Product / Block / PickingTask / Order / OrderingSession.
 */
const ProductVector = require('../models/ProductVector');
const cache = require('../utils/cache');
const { withLock } = require('../utils/lock');
const {
  ALGORITHM_VERSION,
  buildVisualSequence,
  mergeFrozenSequenceWithEligible,
} = require('./sellerVisualOrderingAlgo');

const CACHE_TTL_SEC = 8 * 24 * 60 * 60;

async function loadVectorEntries(eligibleProducts) {
  const ids = eligibleProducts.map((p) => p.id ?? p._id).filter(Boolean);
  if (!ids.length) return [];
  const rows = await ProductVector.find(
    { productId: { $in: ids }, geminiVector: { $exists: true, $ne: [] } },
    'productId geminiVector geminiEmbeddingModel geminiEmbeddingDim',
  ).lean();
  const vectorById = new Map(rows.map((row) => [String(row.productId), row]));
  return eligibleProducts.map((product) => {
    const id = String(product.id ?? product._id);
    const row = vectorById.get(id);
    return {
      id,
      orderNumber: product.orderNumber,
      createdAt: product.createdAt,
      vector: row?.geminiVector,
      model: row?.geminiEmbeddingModel || '',
      dim: row?.geminiEmbeddingDim || row?.geminiVector?.length || 0,
    };
  });
}

async function getSellerVisualOrder({ cacheScope, eligibleProducts }) {
  const key = `seller_visual_catalog:v${ALGORITHM_VERSION}:${cacheScope}`;
  let cached = await cache.get(key);
  if (!cached?.ids) {
    cached = await withLock(`seller-visual:${cacheScope}`, async () => {
      const afterWait = await cache.get(key);
      if (afterWait?.ids) return afterWait;
      const startedAt = Date.now();
      const entries = await loadVectorEntries(eligibleProducts);
      const built = buildVisualSequence(entries);
      const value = {
        ids: built.ids,
        meta: { ...built.meta, builtAt: new Date().toISOString(), durationMs: Date.now() - startedAt },
      };
      await cache.set(key, value, CACHE_TTL_SEC);
      if (process.env.VISUAL_ORDER_LOG === 'true') {
        console.info('[seller-visual-order] built', {
          scope: cacheScope,
          products: eligibleProducts.length,
          ...value.meta,
        });
      }
      return value;
    }, { ttlMs: 30_000, waitMs: 30_000 });
  }

  return {
    ids: mergeFrozenSequenceWithEligible(cached.ids, eligibleProducts),
    meta: cached.meta || {},
  };
}

module.exports = { getSellerVisualOrder };
