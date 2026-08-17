'use strict';

const mongoose = require('mongoose');
const Block = require('../models/Block');
const Product = require('../models/Product');
const { appError } = require('../utils/errors');
const { refreshPickingTaskPositions } = require('./taskBuilder');
const { syncMirror } = require('../utils/upsertShopProduct');
const { pruneInvalidBlockProductIds } = require('./blockMembershipPrimitives');

/**
 * Canonical CURRENT Product -> Block membership commands.
 *
 * V48.19 unified only MOVE. V48.20 makes placement/removal/repair use the same
 * domain boundary too, so Express/Socket transports cannot acquire their own
 * versions of Block.productIds / Product.status side effects.
 */

async function repairBlockMissingProducts(blockId, session = null) {
  const result = await pruneInvalidBlockProductIds({ blockId, session, removeArchived: false });
  return result.changed;
}

async function moveProductBetweenBlocks({
  productId,
  fromBlock,
  toBlock,
  toIndex,
  expectedFromVersion = null,
  expectedToVersion = null,
}) {
  const fromBlockId = Number(fromBlock);
  const toBlockId = Number(toBlock);
  const index = Number(toIndex);

  if (
    !productId
    || !Number.isInteger(fromBlockId)
    || !Number.isInteger(toBlockId)
    || !Number.isInteger(index)
  ) {
    throw appError('block_move_invalid_fields');
  }

  let sourceId = null;
  let targetId = null;
  const sameBlock = fromBlockId === toBlockId;

  const session = await mongoose.connection.startSession();
  try {
    try {
      await session.withTransaction(async () => {
        const source = await Block.findOne({ blockId: fromBlockId }).session(session);
        const target = sameBlock
          ? source
          : await Block.findOne({ blockId: toBlockId }).session(session);

        if (!source || !target) throw appError('block_not_found');

        if (expectedFromVersion != null && Number(expectedFromVersion) !== Number(source.version)) {
          throw appError('block_stale', { blockId: source.blockId, currentVersion: source.version });
        }
        if (!sameBlock && expectedToVersion != null && Number(expectedToVersion) !== Number(target.version)) {
          throw appError('block_stale', { blockId: target.blockId, currentVersion: target.version });
        }

        const idx = source.productIds.findIndex((id) => String(id) === String(productId));
        if (idx === -1) throw appError('product_not_in_source_block');

        source.productIds.splice(idx, 1);
        const safeIndex = Math.min(Math.max(0, index), target.productIds.length);
        target.productIds.splice(safeIndex, 0, productId);

        source.version += 1;
        await source.save({ session });
        if (!sameBlock) {
          target.version += 1;
          await target.save({ session });
        }

        sourceId = source._id;
        targetId = target._id;
      });
    } catch (err) {
      if (err?.code === 11000) {
        const placed = await Block.findOne({ productIds: productId }, 'blockId').lean();
        throw appError('product_already_in_block', { existingBlockId: placed?.blockId ?? null });
      }
      throw err;
    }
  } finally {
    await session.endSession();
  }

  // Derived picking position reconciliation is owned by the membership command,
  // never by an individual transport.
  const positionChanges = await refreshPickingTaskPositions();

  return {
    sourceId,
    targetId,
    fromBlockId,
    toBlockId,
    sameBlock,
    positionChanges,
  };
}

async function removeProductFromBlock({ blockId, productId, expectedVersion = null }) {
  const num = Number(blockId);
  if (!num || num < 1) throw appError('block_invalid_number');
  if (!mongoose.Types.ObjectId.isValid(productId)) throw appError('block_invalid_product_id');

  const expected = expectedVersion != null ? Number(expectedVersion) : null;
  const MAX_RETRIES = 5;
  let updatedRaw = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const current = await Block.findOne({ blockId: num }).lean();
    if (!current) throw appError('block_not_found');

    if (expected != null && expected !== current.version) {
      throw appError('block_stale', { currentVersion: current.version });
    }
    if (!current.productIds.some((id) => String(id) === String(productId))) {
      throw appError('product_not_in_block');
    }

    const versionToMatch = expected != null ? expected : current.version;
    updatedRaw = await Block.findOneAndUpdate(
      { blockId: num, version: versionToMatch, productIds: productId },
      { $pull: { productIds: productId }, $inc: { version: 1 } },
      { new: true },
    );
    if (updatedRaw) break;

    if (expected != null) {
      const refreshed = await Block.findOne({ blockId: num }).lean();
      throw appError('block_stale', { currentVersion: refreshed?.version });
    }
  }
  if (!updatedRaw) throw appError('block_concurrent_modification');

  await Product.updateOne(
    { _id: productId, status: { $ne: 'archived' } },
    { $set: { status: 'pending' } },
  );

  const positionChanges = await refreshPickingTaskPositions();
  return { blockMongoId: updatedRaw._id, blockId: num, productId: String(productId), positionChanges };
}

async function placeProductInBlock({ blockId, productId, index = null, expectedVersion = null }) {
  const num = Number(blockId);
  if (!num || num < 1) throw appError('block_invalid_number');
  if (!productId) throw appError('block_missing_product_id');
  if (!mongoose.Types.ObjectId.isValid(productId)) throw appError('block_invalid_product_id');

  const productDoc = await Product.findById(productId, 'status firstBlockPlacedAt').lean();
  if (!productDoc) throw appError('product_not_found');
  if (productDoc.status === 'archived') throw appError('product_archived_cannot_shelve');

  const expected = expectedVersion != null ? Number(expectedVersion) : null;
  const MAX_RETRIES = 5;
  let updatedRaw = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const current = await Block.findOne({ blockId: num }).lean();
    if (!current) throw appError('block_not_found');

    if (expected != null && expected !== current.version) {
      throw appError('block_stale', { currentVersion: current.version });
    }

    const existing = await Block.findOne({ productIds: productId }).lean();
    if (existing) {
      if (existing.blockId === num) {
        throw appError('product_already_in_block', { existingBlockId: existing.blockId });
      }
      throw appError('product_in_other_block', { existingBlockId: existing.blockId });
    }

    const rawIds = current.productIds || [];
    let rawPosition;
    if (rawIds.length === 0 || index == null) {
      rawPosition = rawIds.length;
    } else {
      const visibleDocs = await Product.find(
        { _id: { $in: rawIds }, status: { $in: ['active', 'pending'] } },
        '_id',
      ).lean();
      const visibleIdSet = new Set(visibleDocs.map((p) => String(p._id)));

      const danglingIds = rawIds.filter((id) => !visibleIdSet.has(String(id)));
      if (danglingIds.length) {
        const versionForClean = expected != null ? expected : current.version;
        await Block.updateOne(
          { blockId: num, version: versionForClean },
          { $pull: { productIds: { $in: danglingIds } }, $inc: { version: 1 } },
        );
        continue;
      }

      const visibleIds = rawIds.filter((id) => visibleIdSet.has(String(id)));
      const clampedVisible = Math.min(Math.max(0, Number(index)), visibleIds.length);
      if (clampedVisible === 0) {
        rawPosition = rawIds.findIndex((id) => visibleIdSet.has(String(id)));
        if (rawPosition === -1) rawPosition = rawIds.length;
      } else {
        let seen = 0;
        rawPosition = rawIds.length;
        for (let i = 0; i < rawIds.length; i += 1) {
          if (visibleIdSet.has(String(rawIds[i]))) {
            seen += 1;
            if (seen === clampedVisible) { rawPosition = i + 1; break; }
          }
        }
      }
    }

    const versionToMatch = expected != null ? expected : current.version;
    try {
      updatedRaw = await Block.findOneAndUpdate(
        { blockId: num, version: versionToMatch },
        {
          $push: { productIds: { $each: [productId], $position: rawPosition } },
          $inc: { version: 1 },
        },
        { new: true },
      );
    } catch (err) {
      if (err.code === 11000) {
        const placed = await Block.findOne({ productIds: productId }).lean();
        if (placed) {
          if (placed.blockId === num) {
            throw appError('product_already_in_block', { existingBlockId: placed.blockId });
          }
          throw appError('product_in_other_block', { existingBlockId: placed.blockId });
        }
      }
      throw err;
    }

    if (updatedRaw) break;
    if (expected != null) {
      const refreshed = await Block.findOne({ blockId: num }).lean();
      throw appError('block_stale', { currentVersion: refreshed?.version });
    }
  }
  if (!updatedRaw) throw appError('block_concurrent_modification');

  const activationSet = { status: 'active' };
  if (!productDoc.firstBlockPlacedAt) activationSet.firstBlockPlacedAt = new Date();
  await Product.updateOne({ _id: productId }, { $set: activationSet });

  // ShopProduct remains a derived projection. Durable repair is F-11 / V48.22;
  // this command preserves current fire-and-forget semantics while ensuring every
  // physical placement path invokes it from one place.
  const activatedProduct = await Product.findById(productId);
  if (activatedProduct) syncMirror(activatedProduct).catch(() => {});

  const positionChanges = await refreshPickingTaskPositions();
  return { blockMongoId: updatedRaw._id, blockId: num, productId: String(productId), positionChanges };
}

module.exports = {
  repairBlockMissingProducts,
  moveProductBetweenBlocks,
  removeProductFromBlock,
  placeProductInBlock,
};
