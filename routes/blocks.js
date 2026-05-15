const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Block = require('../models/Block');
const Counter = require('../models/Counter');
const Product = require('../models/Product');
const { getIO } = require('../socket');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');
const { refreshPickingTaskPositions } = require('../services/taskBuilder');

async function emitPositionUpdates() {
  try {
    const changed = await refreshPickingTaskPositions();
    if (changed.length) {
      getIO()?.emit('picking_tasks_positions_updated', changed);
    }
  } catch (err) {
    console.error('[blocks] position refresh error:', err);
  }
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
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } })
    .lean();

  if (limit !== undefined) {
    const total = await Block.countDocuments();
    return res.json({ items: blocks, total });
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

    if (counter.seq < maxBlockId) {
      const updated = await Counter.findOneAndUpdate(
        { name: 'blockId', seq: counter.seq },
        { $set: { seq: maxBlockId } },
        { new: true }
      ).lean();
      if (!updated) {
        continue;
      }
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
        console.warn('[blocks/create] socket emit failed:', e.message);
      }

      return res.status(201).json(created);
    } catch (err) {
      if (err.code === 11000 && attempt < MAX_RETRIES) {
        continue;
      }
      console.error('[blocks/create] Error:', err);
      if (err.code === 11000) throw appError('block_id_conflict');
      throw appError('block_create_failed');
    }
  }

  throw appError('block_id_conflict');
}));

// GET /api/blocks/incoming/products — products not assigned to any block
router.get('/incoming/products', asyncHandler(async (req, res) => {
  const assignedIds = await Block.distinct('productIds');
  const products = await Product.find({
    status: 'active',
    source: 'receive',
    _id: { $nin: assignedIds },
  })
    .sort('-createdAt')
    .lean();
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

  const block = await Block.findOne({ blockId: num })
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } })
    .lean();
  if (!block) throw appError('block_not_found');
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

  let updatedSource;
  let updatedTarget;
  let sourceId;
  let targetId;
  let isSameBlock = false;

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      const source = await Block.findOne({ blockId: fromBlockId }).session(session);
      const target = fromBlockId === toBlockId
        ? source
        : await Block.findOne({ blockId: toBlockId }).session(session);

      if (!source || !target) throw appError('block_not_found');

      // Optimistic lock — refuse if any provided expected version is stale.
      if (expectedFromVersion != null && Number(expectedFromVersion) !== source.version) {
        throw appError('block_stale', { blockId: source.blockId, currentVersion: source.version });
      }
      if (
        fromBlockId !== toBlockId &&
        expectedToVersion != null &&
        Number(expectedToVersion) !== target.version
      ) {
        throw appError('block_stale', { blockId: target.blockId, currentVersion: target.version });
      }

      const idx = source.productIds.findIndex((id) => id.toString() === productId);
      if (idx === -1) throw appError('product_not_in_source_block');

      source.productIds.splice(idx, 1);
      const safeIndex = Math.min(Math.max(0, index), target.productIds.length);
      target.productIds.splice(safeIndex, 0, productId);

      if (fromBlockId === toBlockId) {
        source.version += 1;
        await source.save({ session });
      } else {
        source.version += 1;
        target.version += 1;
        await source.save({ session });
        await target.save({ session });
      }

      // Зберігаємо лише ID збережених документів. populate без { session }
      // читав би поза snapshot транзакції — клієнт міг отримати застарілі
      // або, навпаки, ще не закомічені дані. Робимо populate ПІСЛЯ commit.
      sourceId = source._id;
      targetId = target._id;
      isSameBlock = fromBlockId === toBlockId;
    });
  } finally {
    session.endSession();
  }

  updatedSource = await Block.findById(sourceId)
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } })
    .lean();
  updatedTarget = isSameBlock
    ? updatedSource
    : await Block.findById(targetId)
        .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } })
        .lean();

  try {
    const io = getIO();
    io.emit('block_updated', slimBlock(updatedSource));
    if (fromBlockId !== toBlockId) {
      io.emit('block_updated', slimBlock(updatedTarget));
    }
  } catch (_) {}

  emitPositionUpdates();
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
  if (!mongoose.Types.ObjectId.isValid(productId)) throw appError('block_invalid_product_id');

  // Optimistic lock can be passed via query or header to keep DELETE body-free.
  const expectedVersionRaw = req.query.expectedVersion ?? req.get('if-match');
  const expectedVersion = expectedVersionRaw != null ? Number(expectedVersionRaw) : null;

  const MAX_RETRIES = 5;
  let updatedRaw = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const current = await Block.findOne({ blockId: num }).lean();
    if (!current) throw appError('block_not_found');

    if (expectedVersion != null && expectedVersion !== current.version) {
      throw appError('block_stale', { currentVersion: current.version });
    }

    if (!current.productIds.some((id) => String(id) === String(productId))) {
      throw appError('product_not_in_block');
    }

    const versionToMatch = expectedVersion != null ? expectedVersion : current.version;
    updatedRaw = await Block.findOneAndUpdate(
      { blockId: num, version: versionToMatch, productIds: productId },
      { $pull: { productIds: productId }, $inc: { version: 1 } },
      { new: true },
    );
    if (updatedRaw) break;

    // Збій збігу версії: якщо клієнт надіслав expectedVersion — це stale,
    // повідомляємо явно. Інакше — паралельний запис; читаємо свіжу версію
    // і повторюємо.
    if (expectedVersion != null) {
      const refreshed = await Block.findOne({ blockId: num }).lean();
      throw appError('block_stale', { currentVersion: refreshed?.version });
    }
  }
  if (!updatedRaw) throw appError('block_concurrent_modification');

  const updated = await Block.findById(updatedRaw._id)
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } })
    .lean();

  try {
    const io = getIO();
    io.emit('block_updated', slimBlock(updated));
    io.emit('incoming_updated');
    io.emit('catalogue_updated');
  } catch (_) {}

  emitPositionUpdates();
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
  if (!productId) throw appError('block_missing_product_id');
  if (!mongoose.Types.ObjectId.isValid(productId)) throw appError('block_invalid_product_id');

  const MAX_RETRIES = 5;
  let updatedRaw = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const current = await Block.findOne({ blockId: num }).lean();
    if (!current) throw appError('block_not_found');

    if (expectedVersion != null && Number(expectedVersion) !== current.version) {
      throw appError('block_stale', { currentVersion: current.version });
    }

    // М'яка попередня перевірка для людського повідомлення (з номером блока).
    // Жорсткий гарант — унікальний індекс нижче.
    const existing = await Block.findOne({ productIds: productId }).lean();
    if (existing) {
      if (existing.blockId === num) {
        throw appError('product_already_in_block', { existingBlockId: existing.blockId });
      }
      throw appError('product_in_other_block', { existingBlockId: existing.blockId });
    }

    const safeIndex = index != null
      ? Math.min(Math.max(0, Number(index)), current.productIds.length)
      : current.productIds.length;
    const versionToMatch = expectedVersion != null ? Number(expectedVersion) : current.version;

    try {
      updatedRaw = await Block.findOneAndUpdate(
        { blockId: num, version: versionToMatch },
        {
          $push: { productIds: { $each: [productId], $position: safeIndex } },
          $inc: { version: 1 },
        },
        { new: true },
      );
    } catch (err) {
      if (err.code === 11000) {
        // Race програно: інший паралельний запит уже розмістив цей товар.
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

    if (expectedVersion != null) {
      const refreshed = await Block.findOne({ blockId: num }).lean();
      throw appError('block_stale', { currentVersion: refreshed?.version });
    }
  }
  if (!updatedRaw) throw appError('block_concurrent_modification');

  const updated = await Block.findById(updatedRaw._id)
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } })
    .lean();

  // Broadcast to all clients so they see the update in real time.
  // catalogue_updated signals sellers that a new product appeared in the catalogue.
  try {
    const io = getIO();
    io.emit('block_updated', slimBlock(updated));
    io.emit('catalogue_updated');
  } catch (_) { /* socket not initialized yet */ }

  emitPositionUpdates();
  res.json(updated);
}));

module.exports = router;
