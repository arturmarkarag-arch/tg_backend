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
  const counter = await Counter.findOneAndUpdate(
    { name: 'blockId' },
    { $max: { seq: maxBlockId }, $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return counter.seq;
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
      status: { $in: ['active', 'pending'] },
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
  const { productId, fromBlock, toBlock, toIndex } = req.body;
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

// POST /api/blocks/:number/add — add product to block
router.post('/:number/add', staffOnly, async (req, res) => {
  const num = Number(req.params.number);
  const { productId, index } = req.body;
  if (!productId) return res.status(400).json({ error: 'Missing productId' });

  const block = await Block.findOne({ blockId: num });
  if (!block) return res.status(404).json({ error: 'Block not found' });

  const safeIndex = index != null ? Math.min(Math.max(0, index), block.productIds.length) : block.productIds.length;
  block.productIds.splice(safeIndex, 0, productId);
  block.version += 1;
  await block.save();

  await block.populate('productIds');
  const updated = block.toObject();

  // Broadcast to all clients so they see the update in real time
  try {
    const io = getIO();
    io.emit('block_updated', slimBlock(updated));
  } catch (_) { /* socket not initialized yet */ }

  res.json(updated);
});

module.exports = router;
