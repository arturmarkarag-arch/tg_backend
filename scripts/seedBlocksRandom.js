/**
 * Seed script: distribute all active/pending products across random blocks (1-120).
 * Products are sorted by orderNumber, so within each block the relative order is preserved.
 * Existing block assignments are cleared first.
 */

require('dotenv').config({ path: '../.env' });
const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/tg_manager';

async function main() {
  await mongoose.connect(uri);
  console.log('Connected to', uri);

  const Block = require('../models/Block');
  const Product = require('../models/Product');

  // Ensure 120 blocks exist
  const count = await Block.countDocuments();
  if (count < 120) {
    const existing = await Block.find({}, 'blockId').lean();
    const existingNumbers = new Set(existing.map((b) => b.blockId));
    const toCreate = [];
    for (let i = 1; i <= 120; i++) {
      if (!existingNumbers.has(i)) toCreate.push({ blockId: i, productIds: [] });
    }
    if (toCreate.length) await Block.insertMany(toCreate);
    console.log(`Created ${toCreate.length} missing blocks`);
  }

  // Clear all block assignments
  await Block.updateMany({}, { $set: { productIds: [], version: 0 } });
  console.log('Cleared all blocks');

  // Get products in the same order as /shelf page: non-archived, sorted by orderNumber asc, createdAt desc
  const products = await Product.find({ status: { $ne: 'archived' } })
    .sort({ orderNumber: 1, createdAt: -1 })
    .lean();

  console.log(`Found ${products.length} products to distribute`);

  if (!products.length) {
    console.log('No products to distribute. Done.');
    process.exit(0);
  }

  // Build a map: blockId -> [productId, ...]
  const blockMap = new Map();
  for (let i = 1; i <= 120; i++) {
    blockMap.set(i, []);
  }

  // Distribute products sequentially across blocks in order
  const totalBlocks = 120;
  const perBlock = Math.ceil(products.length / totalBlocks);
  for (let i = 0; i < products.length; i++) {
    const blockId = Math.floor(i / perBlock) + 1;
    blockMap.get(blockId).push(products[i]._id);
  }

  // Write to DB
  const ops = [];
  for (const [blockId, productIds] of blockMap) {
    if (productIds.length > 0) {
      ops.push(Block.updateOne({ blockId }, { $set: { productIds }, $inc: { version: 1 } }));
    }
  }
  await Promise.all(ops);

  // Stats
  let filled = 0;
  let maxProducts = 0;
  for (const [, pids] of blockMap) {
    if (pids.length > 0) filled++;
    if (pids.length > maxProducts) maxProducts = pids.length;
  }
  console.log(`Distributed ${products.length} products across ${filled} blocks (max ${maxProducts} per block)`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
