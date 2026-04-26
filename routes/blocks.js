const express = require('express');
const router = express.Router();
const Block = require('../models/Block');
const Product = require('../models/Product');
const { getIO } = require('../socket');

// Seed 120 blocks if they don't exist
async function ensureBlocks() {
  const count = await Block.countDocuments();
  if (count >= 120) return;
  const existing = await Block.find({}, 'blockId').lean();
  const existingNumbers = new Set(existing.map((b) => b.blockId));
  const toCreate = [];
  for (let i = 1; i <= 120; i++) {
    if (!existingNumbers.has(i)) toCreate.push({ blockId: i, productIds: [] });
  }
  if (toCreate.length) await Block.insertMany(toCreate);
}

// GET /api/blocks — all blocks with product count, or paginated blocks when limit/offset are supplied
router.get('/', async (req, res) => {
  await ensureBlocks();
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
});

// POST /api/blocks — create a new block with the next sequential blockId
router.post('/', async (req, res) => {
  try {
    const lastBlock = await Block.findOne().sort({ blockId: -1 }).lean();
    const nextBlockId = lastBlock ? lastBlock.blockId + 1 : 1;
    const block = await Block.create({ blockId: nextBlockId, productIds: [] });
    const created = await Block.findById(block._id).populate('productIds').lean();

    try {
      const io = getIO();
      io.emit('block_updated', created);
    } catch (_) {}

    res.status(201).json(created);
  } catch (err) {
    console.error('[blocks/create] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/blocks/incoming/products — products not assigned to any block
router.get('/incoming/products', async (req, res) => {
  const assignedIds = await Block.distinct('productIds');
  const products = await Product.find({
    status: { $in: ['active', 'pending'] },
    _id: { $nin: assignedIds },
  })
    .sort('-createdAt')
    .lean();
  res.json(products);
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
  const num = Number(req.params.number);
  if (!num || num < 1) return res.status(400).json({ error: 'Invalid block number' });

  await ensureBlocks();
  const block = await Block.findOne({ blockId: num })
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } })
    .lean();
  if (!block) return res.status(404).json({ error: 'Block not found' });
  res.json(block);
});

// POST /api/blocks/move — move product between blocks
router.post('/move', async (req, res) => {
  const { productId, fromBlock, toBlock, toIndex } = req.body;
  if (!productId || !fromBlock || !toBlock || toIndex == null) {
    return res.status(400).json({ error: 'Missing required fields: productId, fromBlock, toBlock, toIndex' });
  }

  try {
    const source = await Block.findOne({ blockId: fromBlock });
    const target = fromBlock === toBlock ? source : await Block.findOne({ blockId: toBlock });

    if (!source || !target) {
      return res.status(404).json({ error: 'Block not found' });
    }

    const idx = source.productIds.findIndex((id) => id.toString() === productId);
    if (idx === -1) {
      return res.status(400).json({ error: 'Product not found in source block' });
    }
    source.productIds.splice(idx, 1);
    const safeIndex = Math.min(Math.max(0, toIndex), target.productIds.length);
    target.productIds.splice(safeIndex, 0, productId);

    if (fromBlock === toBlock) {
      source.version += 1;
      await source.save();
    } else {
      source.version += 1;
      target.version += 1;
      await source.save();
      await target.save();
    }

    const updatedSource = await Block.findOne({ blockId: fromBlock }).populate('productIds').lean();
    const updatedTarget = fromBlock === toBlock
      ? updatedSource
      : await Block.findOne({ blockId: toBlock }).populate('productIds').lean();

    try {
      const io = getIO();
      io.emit('block_updated', updatedSource);
      if (fromBlock !== toBlock) {
        io.emit('block_updated', updatedTarget);
      }
    } catch (_) {}

    res.json({ source: updatedSource, target: updatedTarget });
  } catch (err) {
    console.error('[blocks/move] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/blocks/:number/add — add product to block
router.post('/:number/add', async (req, res) => {
  const num = Number(req.params.number);
  const { productId, index } = req.body;
  if (!productId) return res.status(400).json({ error: 'Missing productId' });

  const block = await Block.findOne({ blockId: num });
  if (!block) return res.status(404).json({ error: 'Block not found' });

  const safeIndex = index != null ? Math.min(Math.max(0, index), block.productIds.length) : block.productIds.length;
  block.productIds.splice(safeIndex, 0, productId);
  block.version += 1;
  await block.save();

  const updated = await Block.findOne({ blockId: num }).populate('productIds').lean();

  // Broadcast to all clients so they see the update in real time
  try {
    const io = getIO();
    io.emit('block_updated', updated);
  } catch (_) { /* socket not initialized yet */ }

  res.json(updated);
});

module.exports = router;
