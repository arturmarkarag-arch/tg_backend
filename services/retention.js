'use strict';

const mongoose = require('mongoose');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const ShopProduct = require('../models/ShopProduct');
const ProductVector = require('../models/ProductVector');

// A warehouse product that has stayed archived this long is treated as "no longer the
// warehouse's concern, but still worth keeping in the shop catalogue" — see
// convertStaleArchivedToShop. Restoring it within the window cancels the conversion.
const ARCHIVE_TO_SHOP_DAYS = 30;

// Completed picking tasks are deliberately KEPT after a session ends (so the
// session's "зібрано N" summary survives), but only the CURRENT session is ever
// counted on the board — tasks from sessions weeks in the past are pure dead
// weight. A TTL index can't express "status === 'completed' AND old" (TTL indexes
// cannot be partial), so this is swept on a schedule instead of by the engine.
const COMPLETED_PICKING_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

async function purgeOldCompletedPickingTasks(now = Date.now()) {
  const cutoff = new Date(now - COMPLETED_PICKING_RETENTION_DAYS * DAY_MS);
  const { deletedCount } = await PickingTask.deleteMany({
    status: 'completed',
    updatedAt: { $lt: cutoff },
  });
  return deletedCount || 0;
}

// Build the shop-OWNED field set from a warehouse product (same shape upsertShopProduct
// uses for a mirror). Drops the barcode if another ShopProduct already holds it, so a
// fresh create can't trip the unique partial barcode index.
async function shopFieldsFromProduct(p, session) {
  let barcode = String(p.barcode || '').trim();
  if (barcode && (await ShopProduct.exists({ barcode }).session(session))) barcode = '';
  return {
    name:               p.name || p.brand || p.model || p.category || '',
    price:              p.price || 0,
    quantityPerPackage: p.quantityPerPackage || 0,
    notes:              p.notes || '',
    originalImageUrl:   p.originalImageUrl || p.imageUrls?.[0] || '',
    imageUrl:           p.imageUrls?.[0] || '',
    labelPositions:     p.labelPositions || {},
    aiDescription:      p.aiDescription || '',
    barcode,
    source:             'receive',
    linkedProductId:    null, // shop-OWNED
  };
}

// Copy the warehouse product's vector (ProductVector{productId}) into a shop-owned row
// keyed by shopProductId so the handed-over product stays findable by photo. Idempotent
// (upsert). The original warehouse row is KEPT — we never delete data.
async function copyVectorToShopOwned(productId, shopProductId, session) {
  const src = await ProductVector.findOne({ productId }).session(session).lean();
  if (!src || !src.geminiVector?.length) return;
  await ProductVector.updateOne(
    { shopProductId },
    {
      $setOnInsert: { shopProductId },
      $set: {
        geminiVector:         src.geminiVector,
        geminiEmbeddingModel: src.geminiEmbeddingModel,
        geminiEmbeddingDim:   src.geminiEmbeddingDim,
        geminiEmbeddedAt:     src.geminiEmbeddedAt,
        geminiFromLabeled:    src.geminiFromLabeled,
      },
    },
    { upsert: true, session },
  );
}

// Hand stale-archived warehouse products over to the shop catalogue. For each product
// archived ≥ ARCHIVE_TO_SHOP_DAYS ago and not yet converted:
//   • if it has a mirror → DETACH it (linkedProductId → null) so it becomes a standalone
//     shop-OWNED product (editable, with its own vector row).
//   • else if it has searchable content → CREATE a shop-OWNED product from its fields.
//   • copy the vector across; stamp shopConvertedAt so it's processed exactly once.
// All per-product steps run in ONE transaction → safe to retry, no half-conversions /
// duplicates. The archived Product and its original vector are kept forever.
async function convertStaleArchivedToShop(now = Date.now()) {
  const cutoff = new Date(now - ARCHIVE_TO_SHOP_DAYS * DAY_MS);
  const stale = await Product.find(
    { status: 'archived', archivedAt: { $lt: cutoff }, shopConvertedAt: null },
    '_id',
  ).lean();

  let converted = 0;
  for (const { _id } of stale) {
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        // Re-read inside the tx: a concurrent restore may have un-archived it, or a
        // previous attempt may have already converted it.
        const p = await Product.findById(_id).session(session);
        if (!p || p.status !== 'archived' || p.shopConvertedAt) return;

        let shopProductId = null;
        const mirror = await ShopProduct.findOne({ linkedProductId: p._id }).session(session);
        if (mirror) {
          mirror.linkedProductId = null; // mirror → standalone shop-owned product
          await mirror.save({ session });
          shopProductId = mirror._id;
        } else {
          const hasContent = Boolean(p.imageUrls?.[0] || p.originalImageUrl || p.name || String(p.barcode || '').trim());
          if (hasContent) {
            const fields = await shopFieldsFromProduct(p, session);
            const [created] = await ShopProduct.create([fields], { session });
            shopProductId = created._id;
          }
        }

        if (shopProductId) await copyVectorToShopOwned(p._id, shopProductId, session);

        p.shopConvertedAt = new Date();
        await p.save({ session });
        converted += 1;
      });
    } catch (err) {
      console.error('[retention] convert-to-shop failed for', String(_id), ':', err?.message);
    } finally {
      await session.endSession();
    }
  }
  return converted;
}

// Run the (non-TTL) sweeps now and then once a day. TTL-based log retention is
// handled by MongoDB itself via the indexes declared on the log schemas — only
// the filtered PickingTask purge needs an application-side timer. The interval is
// unref()'d so it never keeps the process alive on shutdown.
function startRetentionScheduler() {
  const runOnce = async () => {
    try {
      const n = await purgeOldCompletedPickingTasks();
      if (n) console.log(`[retention] purged ${n} completed picking task(s) older than ${COMPLETED_PICKING_RETENTION_DAYS}d`);
    } catch (err) {
      console.error('[retention] purge failed:', err?.message);
    }
    try {
      const c = await convertStaleArchivedToShop();
      if (c) console.log(`[retention] handed over ${c} product(s) archived >${ARCHIVE_TO_SHOP_DAYS}d to the shop catalogue`);
    } catch (err) {
      console.error('[retention] convert-to-shop sweep failed:', err?.message);
    }
  };
  runOnce();
  const timer = setInterval(runOnce, DAY_MS);
  timer.unref();
  return timer;
}

module.exports = {
  purgeOldCompletedPickingTasks,
  convertStaleArchivedToShop,
  startRetentionScheduler,
  COMPLETED_PICKING_RETENTION_DAYS,
  ARCHIVE_TO_SHOP_DAYS,
};
