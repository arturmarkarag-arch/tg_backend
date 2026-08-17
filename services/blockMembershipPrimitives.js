'use strict';

const Block = require('../models/Block');
const Product = require('../models/Product');
const { appError } = require('../utils/errors');

/**
 * Low-level transaction-aware primitives for CURRENT Product -> Block truth.
 *
 * Application commands own business semantics (Product.status changes, optimistic
 * concurrency, picking-position reconciliation, socket publication). Workflows
 * that already own a wider transaction (archive, batch block-photo creation,
 * test fixture creation) may use these primitives so they do not reimplement
 * Block.productIds writes inside their transport/orchestrator.
 */

async function pruneInvalidBlockProductIds({
  blockId,
  session = null,
  removeArchived = false,
} = {}) {
  const query = Block.findOne({ blockId }).select('productIds version');
  const block = session ? await query.session(session).lean() : await query.lean();
  if (!block || !(block.productIds || []).length) {
    return { blockFound: Boolean(block), changed: false, removedCount: 0, removedIds: [] };
  }

  const validFilter = { _id: { $in: block.productIds } };
  if (removeArchived) validFilter.status = { $ne: 'archived' };
  const productQuery = Product.find(validFilter, '_id');
  const existingProducts = session ? await productQuery.session(session).lean() : await productQuery.lean();
  const existingIds = new Set(existingProducts.map((p) => String(p._id)));
  const removedIds = block.productIds.filter((id) => !existingIds.has(String(id)));
  if (!removedIds.length) {
    return { blockFound: true, changed: false, removedCount: 0, removedIds: [] };
  }

  await Block.updateOne(
    { blockId },
    { $pull: { productIds: { $in: removedIds } }, $inc: { version: 1 } },
    { session },
  );

  return {
    blockFound: true,
    changed: true,
    removedCount: removedIds.length,
    removedIds: removedIds.map(String),
  };
}

async function detachProductFromAllBlocks({ productId, session = null } = {}) {
  if (!productId) throw appError('block_missing_product_id');

  const find = Block.find({ productIds: productId }, 'blockId');
  const affected = session ? await find.session(session).lean() : await find.lean();
  if (!affected.length) return { blockIds: [], modifiedCount: 0 };

  const result = await Block.updateMany(
    { productIds: productId },
    { $pull: { productIds: productId }, $inc: { version: 1 } },
    { session },
  );

  return {
    blockIds: affected.map((row) => row.blockId),
    modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
  };
}

async function appendProductsToBlockDocument({ block, productIds = [], session = null } = {}) {
  if (!block) throw appError('block_not_found');
  const ids = (productIds || []).filter(Boolean);
  if (!ids.length) return block;

  for (const id of ids) block.productIds.push(id);
  block.version = Number(block.version || 0) + 1;
  await block.save({ session });
  return block;
}

module.exports = {
  pruneInvalidBlockProductIds,
  detachProductFromAllBlocks,
  appendProductsToBlockDocument,
};
