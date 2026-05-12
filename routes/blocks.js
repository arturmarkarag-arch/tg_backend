const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Block = require('../models/Block');
const Counter = require('../models/Counter');
const Product = require('../models/Product');
const { getIO } = require('../socket');
const { requireTelegramRoles } = require('../middleware/telegramAuth');

function slimBlock(block) {
  return {
    blockId: block.blockId,
    version: block.version,
    productIds: (block.productIds || []).map((id) => String(id._id || id)),
  };
}

const staffOnly = requireTelegramRoles(['admin', 'warehouse']);

// GET /api/blocks — all blocks with product count, or paginated blocks when limit/offset are supplied
router.get('/', async (req, res) => {
  try {
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
  } catch (err) {
    console.error('[blocks/list] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

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
router.post('/', staffOnly, async (req, res) => {
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const nextBlockId = await getNextBlockId();
      const block = await Block.create({ blockId: nextBlockId, productIds: [] });
      const created = block.toObject();

      try {
        const io = getIO();
        io.emit('block_updated', slimBlock(created));
      } catch (_) {}

      return res.status(201).json(created);
    } catch (err) {
      if (err.code === 11000 && attempt < MAX_RETRIES) {
        continue;
      }
      console.error('[blocks/create] Error:', err);
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Block ID conflict, please retry' });
      }
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(409).json({ error: 'Block ID conflict, please retry' });
});

// GET /api/blocks/incoming/products — products not assigned to any block
router.get('/incoming/products', async (req, res) => {
  try {
    const assignedIds = await Block.distinct('productIds');
    const products = await Product.find({
      status: 'active',
      source: 'receive',
      _id: { $nin: assignedIds },
    })
      .sort('-createdAt')
      .lean();
    res.json(products);
  } catch (err) {
    console.error('[blocks/incoming/products] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/blocks/search/products?q=term — search products across all blocks
router.get('/search/products', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing search query' });

  const products = await Product.find({
    $or: [
      { brand: { $regex: q, $options: 'i' } },
      { model: { $regex: q, $options: 'i' } },
      { category: { $regex: q, $options: 'i' } },
    ],
  }).lean();

  res.json(products);
});

// GET /api/blocks/:number — single block with populated products
router.get('/:number', async (req, res) => {
  try {
    const num = Number(req.params.number);
    if (!num || num < 1) return res.status(400).json({ error: 'Invalid block number' });

    const block = await Block.findOne({ blockId: num })
      .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } })
      .lean();
    if (!block) return res.status(404).json({ error: 'Block not found' });
    res.json(block);
  } catch (err) {
    console.error('[blocks/get] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/blocks/move — move product between blocks
router.post('/move', staffOnly, async (req, res) => {
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
    return res.status(400).json({ error: 'Missing or invalid required fields: productId, fromBlock, toBlock, toIndex' });
  }

  try {
    let updatedSource;
    let updatedTarget;

    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const source = await Block.findOne({ blockId: fromBlockId }).session(session);
        const target = fromBlockId === toBlockId
          ? source
          : await Block.findOne({ blockId: toBlockId }).session(session);

        if (!source || !target) {
          throw Object.assign(new Error('Block not found'), { status: 404 });
        }

        // Optimistic lock — refuse if any provided expected version is stale.
        if (expectedFromVersion != null && Number(expectedFromVersion) !== source.version) {
          throw Object.assign(new Error('Source block was modified by another user'), {
            status: 409,
            code: 'block_stale',
            blockId: source.blockId,
            currentVersion: source.version,
          });
        }
        if (
          fromBlockId !== toBlockId &&
          expectedToVersion != null &&
          Number(expectedToVersion) !== target.version
        ) {
          throw Object.assign(new Error('Target block was modified by another user'), {
            status: 409,
            code: 'block_stale',
            blockId: target.blockId,
            currentVersion: target.version,
          });
        }

        const idx = source.productIds.findIndex((id) => id.toString() === productId);
        if (idx === -1) {
          throw Object.assign(new Error('Product not found in source block'), { status: 400 });
        }

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

        await source.populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } });
        updatedSource = source.toObject();
        updatedTarget = updatedSource;

        if (fromBlockId !== toBlockId) {
          await target.populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } });
          updatedTarget = target.toObject();
        }
      });
    } finally {
      session.endSession();
    }

    try {
      const io = getIO();
      io.emit('block_updated', slimBlock(updatedSource));
      if (fromBlockId !== toBlockId) {
        io.emit('block_updated', slimBlock(updatedTarget));
      }
    } catch (_) {}

    res.json({ source: updatedSource, target: updatedTarget });
  } catch (err) {
    console.error('[blocks/move] Error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/blocks/:number/products/:productId — remove product from block (returns it to incoming)
router.delete('/:number/products/:productId', staffOnly, async (req, res) => {
  const num = Number(req.params.number);
  const { productId } = req.params;
  if (!num || num < 1) return res.status(400).json({ error: 'Invalid block number' });

  // Optimistic lock can be passed via query or header to keep DELETE body-free.
  const expectedVersionRaw = req.query.expectedVersion ?? req.get('if-match');
  const expectedVersion = expectedVersionRaw != null ? Number(expectedVersionRaw) : null;

  try {
    const block = await Block.findOne({ blockId: num });
    if (!block) return res.status(404).json({ error: 'Block not found' });

    if (expectedVersion != null && expectedVersion !== block.version) {
      return res.status(409).json({
        error: 'Block was modified by another user',
        code: 'block_stale',
        currentVersion: block.version,
      });
    }

    const idx = block.productIds.findIndex((id) => id.toString() === productId);
    if (idx === -1) return res.status(404).json({ error: 'Product not in block' });

    block.productIds.splice(idx, 1);
    block.version += 1;
    await block.save();

    await block.populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } });
    const updated = block.toObject();

    try {
      const io = getIO();
      io.emit('block_updated', slimBlock(updated));
      io.emit('incoming_updated');
    } catch (_) {}

    res.json(updated);
  } catch (err) {
    console.error('[blocks/remove-product] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/blocks/:number/add — add product to block
router.post('/:number/add', staffOnly, async (req, res) => {
  const num = Number(req.params.number);
  const { productId, index, expectedVersion } = req.body;
  if (!productId) return res.status(400).json({ error: 'Missing productId' });
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ error: 'Invalid productId' });
  }

  let updated;
  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      const block = await Block.findOne({ blockId: num }).session(session);
      if (!block) {
        throw Object.assign(new Error('Block not found'), { status: 404 });
      }

      // Optimistic lock: if client sent a version, refuse on mismatch so a stale
      // UI cannot blindly overwrite a concurrent change. Backwards-compatible
      // when the field is omitted.
      if (expectedVersion != null && Number(expectedVersion) !== block.version) {
        throw Object.assign(new Error('Block was modified by another user'), {
          status: 409,
          code: 'block_stale',
          currentVersion: block.version,
        });
      }

      // Uniqueness across blocks: a product must live in exactly one block at a
      // time. Without this check warehouse staff could pack the same item from
      // two blocks (double-picking) and picking tasks would resolve ambiguously.
      const existing = await Block.findOne({ productIds: productId }).session(session).lean();
      if (existing) {
        if (existing.blockId === num) {
          throw Object.assign(new Error('Product already in this block'), {
            status: 409,
            code: 'product_already_in_block',
            existingBlockId: existing.blockId,
          });
        }
        throw Object.assign(new Error(`Product is already in block ${existing.blockId}`), {
          status: 409,
          code: 'product_in_other_block',
          existingBlockId: existing.blockId,
        });
      }

      const safeIndex = index != null
        ? Math.min(Math.max(0, Number(index)), block.productIds.length)
        : block.productIds.length;
      block.productIds.splice(safeIndex, 0, productId);
      block.version += 1;
      await block.save({ session });

      await block.populate('productIds');
      updated = block.toObject();
    });
  } catch (err) {
    console.error('[blocks/add] Error:', err.message);
    const status = err.status || 500;
    const payload = { error: err.message };
    if (err.code) payload.code = err.code;
    if (err.existingBlockId != null) payload.existingBlockId = err.existingBlockId;
    if (err.currentVersion != null) payload.currentVersion = err.currentVersion;
    return res.status(status).json(payload);
  } finally {
    session.endSession();
  }

  // Broadcast to all clients so they see the update in real time
  try {
    const io = getIO();
    io.emit('block_updated', slimBlock(updated));
  } catch (_) { /* socket not initialized yet */ }

  res.json(updated);
});

module.exports = router;
