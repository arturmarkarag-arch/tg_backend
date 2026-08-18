const express = require('express');
const router = express.Router();
const Block = require('../models/Block');
const Counter = require('../models/Counter');
const Product = require('../models/Product');
const ReceiptItem = require('../models/ReceiptItem');
const { getIO } = require('../socket');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');
const {
  repairBlockMissingProducts,
  moveProductBetweenBlocks,
  removeProductFromBlock,
  placeProductInBlock,
} = require('../services/blockMoveCommand');
const { withLock } = require('../utils/lock');

// On the "Полки" board a product tile renders ONLY its photo. Everything else
// on the warehouse Product — name, price,
// quantity, barcode, aiDescription, labelPositions, pendingShopUpdate,
// storeLinks, … — is dead weight here, and a single block can hold 200+
// products, so populating full docs ships hundreds of KB per board read for
// nothing. Project just what ProductImage + the card need. (`_id` is implicit.)
const BLOCK_PRODUCT_FIELDS = 'imageUrls localImageUrl originalImageUrl receiptItemId';

// Product.receiptItemId is canonical for current rows. Older receipt-created
// products can have only the reverse ReceiptItem.createdProductId link, so board
// reads repair that relation in-memory with one batched query. The client can
// then disable «Прийомка» truthfully without probing an endpoint on every tile.
async function attachReceiptItemLinks(products = []) {
  const rows = products.filter((product) => product && typeof product === 'object');
  const unresolvedIds = rows
    .filter((product) => !product.receiptItemId && product._id)
    .map((product) => product._id);
  if (!unresolvedIds.length) return products;

  const legacyLinks = await ReceiptItem.find(
    { createdProductId: { $in: unresolvedIds } },
    '_id createdProductId',
  ).sort({ createdAt: -1 }).lean();
  const byProductId = new Map();
  for (const item of legacyLinks) {
    const productId = String(item.createdProductId || '');
    if (productId && !byProductId.has(productId)) byProductId.set(productId, item._id);
  }
  for (const product of rows) {
    if (!product.receiptItemId) product.receiptItemId = byProductId.get(String(product._id)) || null;
  }
  return products;
}

async function attachBlockReceiptItemLinks(blocks = []) {
  await attachReceiptItemLinks(blocks.flatMap((block) => block?.productIds || []));
  return blocks;
}

function slimBlock(block) {
  return {
    blockId: block.blockId,
    version: block.version,
    productIds: (block.productIds || []).map((id) => String(id._id || id)),
  };
}

const staffOnly = requireTelegramRoles(['admin', 'warehouse']);

// GET /api/blocks — all blocks with product count, or paginated blocks when limit/offset are supplied
router.get('/', asyncHandler(async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const offset = req.query.offset ? Number(req.query.offset) : 0;
  const query = Block.find().sort('blockId');

  if (limit !== undefined) {
    query.skip(offset).limit(limit);
  }

  const blocks = await query
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } }, select: BLOCK_PRODUCT_FIELDS })
    .lean();
  await attachBlockReceiptItemLinks(blocks);

  if (limit !== undefined) {
    const [total, maxDoc] = await Promise.all([
      Block.countDocuments(),
      Block.findOne({}, 'blockId').sort({ blockId: -1 }).lean(),
    ]);
    return res.json({ items: blocks, total, maxBlockId: maxDoc?.blockId ?? 0 });
  }

  res.json(blocks);
}));

async function getNextBlockId() {
  const maxBlock = await Block.findOne({}, 'blockId').sort({ blockId: -1 }).lean();
  const maxBlockId = maxBlock ? maxBlock.blockId : 0;

  while (true) {
    const counter = await Counter.findOne({ name: 'blockId' }).lean();
    if (!counter) {
      try {
        const created = await Counter.create({ name: 'blockId', seq: maxBlockId + 1 });
        return created.seq;
      } catch (err) {
        if (err.code === 11000) {
          continue;
        }
        throw err;
      }
    }

    // Under the blocks:sequence lock the counter must mirror the real tail.
    // This also self-heals older deployments where deleting a tail block left
    // Counter.seq ahead of maxBlockId and the next create would skip a number.
    if (counter.seq !== maxBlockId) {
      const updated = await Counter.findOneAndUpdate(
        { name: 'blockId', seq: counter.seq },
        { $set: { seq: maxBlockId } },
        { new: true }
      ).lean();
      if (!updated) continue;
    }

    const updatedCounter = await Counter.findOneAndUpdate(
      { name: 'blockId' },
      { $inc: { seq: 1 } },
      { new: true }
    ).lean();
    return updatedCounter.seq;
  }
}

// POST /api/blocks — create a new block with the next sequential blockId
router.post('/', staffOnly, asyncHandler(async (req, res) => {
  return withLock('blocks:sequence', async () => {
    const MAX_RETRIES = 5;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const nextBlockId = await getNextBlockId();
        const block = await Block.create({ blockId: nextBlockId, productIds: [] });
        const created = block.toObject();

        try {
          const io = getIO();
          io.emit('block_updated', slimBlock(created));
        } catch (e) {
        }

        return res.status(201).json(created);
      } catch (err) {
        if (err.code === 11000 && attempt < MAX_RETRIES) continue;
        if (err.code === 11000) throw appError('block_id_conflict');
        throw appError('block_create_failed');
      }
    }

    throw appError('block_id_conflict');
  }, { ttlMs: 10_000, waitMs: 5_000 });
}));

// GET /api/blocks/incoming/products — products not assigned to any block.
// qty>0 hides normal receipts that have nothing to place, but restoredFromArchive
// items are surfaced regardless of quantity — restore lands them with qty=0
// pending the worker's physical count, so they must be visible to be bumpable.
// See [[product-restore-from-archive]].
router.get('/incoming/products', asyncHandler(async (req, res) => {
  const assignedIds = await Block.distinct('productIds');
  const products = await Product.find({
    // Надходження = NOT in a block, awaiting placement → 'pending' (active⟺in-block).
    status: 'pending',
    source: { $in: ['receive', 'receipt'] },
    // Legacy supplement-only rows may still have a technical Product with
    // orderingEnabled=false. New Wave-based supplement-only items own no Product.
    // Only real warehouse-routed goods belong in the Надходження placement queue.
    orderingEnabled: { $ne: false },
    _id: { $nin: assignedIds },
    // New receipt flow keeps received quantity as reference metadata rather
    // than pretending it is the exact warehouse remainder, so a receipt product
    // with quantity=0 must still be placeable. Restores remain visible too.
    $or: [
      { source: 'receipt' },
      { quantity: { $gt: 0 } },
      { restoredFromArchive: true },
    ],
  })
    .select(BLOCK_PRODUCT_FIELDS)
    .sort('-createdAt')
    .lean();
  await attachReceiptItemLinks(products);
  res.json(products);
}));

// GET /api/blocks/search/products?q=term — search products across all blocks
router.get('/search/products', asyncHandler(async (req, res) => {
  const q = req.query.q;
  if (!q) throw appError('block_search_query_required');

  const products = await Product.find({
    $or: [
      { brand: { $regex: q, $options: 'i' } },
      { model: { $regex: q, $options: 'i' } },
      { category: { $regex: q, $options: 'i' } },
    ],
  }).lean();

  res.json(products);
}));

// GET /api/blocks/:number — single block with populated products
router.get('/:number', asyncHandler(async (req, res) => {
  const num = Number(req.params.number);
  if (!num || num < 1) throw appError('block_invalid_number');

  await repairBlockMissingProducts(num);

  const block = await Block.findOne({ blockId: num })
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } }, select: BLOCK_PRODUCT_FIELDS })
    .lean();
  if (!block) throw appError('block_not_found');
  await attachBlockReceiptItemLinks([block]);
  res.json(block);
}));

// POST /api/blocks/move — move product between blocks
router.post('/move', staffOnly, asyncHandler(async (req, res) => {
  const { productId, fromBlock, toBlock, toIndex, expectedFromVersion, expectedToVersion } = req.body;
  const fromBlockId = Number(fromBlock);
  const toBlockId = Number(toBlock);
  const index = Number(toIndex);

  if (
    !productId ||
    !Number.isInteger(fromBlockId) ||
    !Number.isInteger(toBlockId) ||
    !Number.isInteger(index)
  ) {
    throw appError('block_move_invalid_fields');
  }

  const moveResult = await moveProductBetweenBlocks({
    productId,
    fromBlock: fromBlockId,
    toBlock: toBlockId,
    toIndex: index,
    expectedFromVersion,
    expectedToVersion,
  });

  const { sourceId, targetId, sameBlock: isSameBlock, positionChanges } = moveResult;
  let updatedSource;
  let updatedTarget;

  updatedSource = await Block.findById(sourceId)
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } }, select: BLOCK_PRODUCT_FIELDS })
    .lean();
  updatedTarget = isSameBlock
    ? updatedSource
    : await Block.findById(targetId)
        .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } }, select: BLOCK_PRODUCT_FIELDS })
        .lean();
  await attachBlockReceiptItemLinks(isSameBlock ? [updatedSource] : [updatedSource, updatedTarget]);

  try {
    const io = getIO();
    io.emit('block_updated', slimBlock(updatedSource));
    if (fromBlockId !== toBlockId) {
      io.emit('block_updated', slimBlock(updatedTarget));
    }
  } catch (_) {}

  if (positionChanges.length) {
    try { getIO()?.emit('picking_tasks_positions_updated', positionChanges); } catch (_) {}
  }
  res.json({ source: updatedSource, target: updatedTarget });
}));

// DELETE /api/blocks/:number/products/:productId — remove product from block (returns it to incoming)
//
// Реалізовано як атомарний findOneAndUpdate з $pull + $inc(version), бо
// раніше findOne -> splice -> save() мав race condition: дві паралельні
// DELETE без expectedVersion читали один і той самий productIds, кожен
// видаляв свій id, останній save() перетирав попередній — видалений товар
// «повертався» у блок. Тепер write проходить лише при збігу version.
router.delete('/:number/products/:productId', staffOnly, asyncHandler(async (req, res) => {
  const num = Number(req.params.number);
  const { productId } = req.params;
  if (!num || num < 1) throw appError('block_invalid_number');

  // Optimistic lock can be passed via query or header to keep DELETE body-free.
  const expectedVersionRaw = req.query.expectedVersion ?? req.get('if-match');
  const expectedVersion = expectedVersionRaw != null ? Number(expectedVersionRaw) : null;

  const removal = await removeProductFromBlock({
    blockId: num,
    productId,
    expectedVersion,
  });

  const updated = await Block.findById(removal.blockMongoId)
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } }, select: BLOCK_PRODUCT_FIELDS })
    .lean();

  try {
    const io = getIO();
    io.emit('block_updated', slimBlock(updated));
    io.emit('incoming_updated');
    io.emit('catalogue_updated', { action: 'add' });
  } catch (_) {}

  if (removal.positionChanges.length) {
    try { getIO()?.emit('picking_tasks_positions_updated', removal.positionChanges); } catch (_) {}
  }
  res.json(updated);
}));

// POST /api/blocks/:number/add — add product to block
//
// Атомарно через findOneAndUpdate з фільтром по version. Унікальний multikey-
// індекс на productIds — фінальний бар'єр від race condition між двома різними
// блоками: якщо два запити одночасно намагаються додати один і той же товар
// у різні блоки, другий отримає duplicate-key (E11000) і ми повертаємо
// product_in_other_block з актуальним номером блока.
router.post('/:number/add', staffOnly, asyncHandler(async (req, res) => {
  const num = Number(req.params.number);
  const { productId, index, expectedVersion } = req.body;
  if (!num || num < 1) throw appError('block_invalid_number');

  const placement = await placeProductInBlock({
    blockId: num,
    productId,
    index,
    expectedVersion,
  });

  const updated = await Block.findById(placement.blockMongoId)
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } }, select: BLOCK_PRODUCT_FIELDS })
    .lean();

  // Transport owns publication only. Domain writes and picking-position repair
  // are performed by the canonical Product -> Block command above.
  try {
    const io = getIO();
    io.emit('block_updated', slimBlock(updated));
    io.emit('catalogue_updated', { action: 'add' });
  } catch (_) { /* socket not initialized yet */ }

  if (placement.positionChanges.length) {
    try { getIO()?.emit('picking_tasks_positions_updated', placement.positionChanges); } catch (_) {}
  }
  res.json(updated);
}));

// DELETE /api/blocks/:number — only the EMPTY TAIL block may be removed.
// Example: with blocks 1..20, #20 may be deleted; only then #19 becomes the
// tail and may be deleted. This preserves a gap-free physical block sequence.
router.delete('/:number', requireTelegramRoles(['admin', 'warehouse', 'manager']), asyncHandler(async (req, res) => {
  const num = Number(req.params.number);
  if (!Number.isInteger(num) || num < 1) throw appError('block_invalid_number');

  return withLock('blocks:sequence', async () => {
    const [block, maxBlock] = await Promise.all([
      Block.findOne({ blockId: num }).lean(),
      Block.findOne({}, 'blockId').sort({ blockId: -1 }).lean(),
    ]);
    if (!block) throw appError('block_not_found');
    if (!maxBlock || Number(maxBlock.blockId) !== num) {
      throw appError('block_delete_tail_only', { maxBlockId: maxBlock?.blockId ?? null });
    }

    // "Empty" is literal here. Do not silently ignore archived/missing refs: a
    // block may be deleted only after its stored sequence itself is empty. This
    // keeps block numbering and any diagnostic/history tooling unambiguous.
    if ((block.productIds || []).length > 0) throw appError('block_not_empty');

    await Block.deleteOne({ blockId: num });
    const newMax = await Block.findOne({}, 'blockId').sort({ blockId: -1 }).lean();
    await Counter.findOneAndUpdate(
      { name: 'blockId' },
      { $set: { seq: Number(newMax?.blockId || 0) } },
      { upsert: true, new: true },
    );

    try {
      const io = getIO();
      io.emit('block_deleted', { blockId: num, maxBlockId: Number(newMax?.blockId || 0) });
    } catch (_) { /* socket not ready */ }

    return res.json({ ok: true, blockId: num, maxBlockId: Number(newMax?.blockId || 0) });
  }, { ttlMs: 10_000, waitMs: 5_000 });
}));

module.exports = router;
