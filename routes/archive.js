const express = require('express');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const Product = require('../models/Product');
const { shiftUp } = require('../utils/shiftOrderNumbers');

const router = express.Router();

const r2Client = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

async function deleteFromR2(imageNames = []) {
  for (const name of imageNames) {
    try {
      await r2Client.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: `products/${name}`,
      }));
    } catch (err) {
      console.error(`Failed to delete R2 object products/${name}:`, err.message);
    }
  }
}

/**
 * GET /api/archive?page=1&pageSize=10
 * Returns archived products grouped by archivedAt date (day),
 * sorted newest-day-first, within each day newest-first.
 * Only includes products archived within the last 30 days.
 */
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  const total = await Product.countDocuments({ status: 'archived', archivedAt: { $gte: cutoff } });

  const products = await Product.find({ status: 'archived', archivedAt: { $gte: cutoff } })
    .sort({ archivedAt: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize);

  // Group by calendar day (UTC date string)
  const grouped = [];
  const dayMap = new Map();
  for (const p of products) {
    const day = p.archivedAt
      ? p.archivedAt.toISOString().slice(0, 10)
      : 'невідомо';
    if (!dayMap.has(day)) {
      dayMap.set(day, []);
      grouped.push({ day, items: dayMap.get(day) });
    }
    dayMap.get(day).push(p);
  }

  res.json({
    total,
    page,
    pageSize,
    pageCount: Math.ceil(total / pageSize),
    groups: grouped,
  });
});

/**
 * POST /api/archive/:id/restore
 * Restore an archived product back to active status.
 */
router.post('/:id/restore', async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (product.status !== 'archived') return res.status(400).json({ error: 'Product is not archived' });

  // Determine restore position: original position or end of list
  let restoreOrder;
  if (product.originalOrderNumber) {
    restoreOrder = product.originalOrderNumber;
    // Shift existing products at and after this position up by 1
    await shiftUp({ status: { $ne: 'archived' }, orderNumber: { $gte: restoreOrder } });
  } else {
    const maxOrder = await Product.findOne({ status: { $ne: 'archived' } })
      .sort({ orderNumber: -1 })
      .select('orderNumber')
      .lean();
    restoreOrder = (maxOrder?.orderNumber || 0) + 1;
  }

  product.status = 'active';
  product.archivedAt = null;
  product.originalOrderNumber = null;
  product.orderNumber = restoreOrder;
  await product.save();

  res.json(product);
});

/**
 * DELETE /api/archive/:id
 * Permanently delete an archived product and its R2 images.
 */
router.delete('/:id', async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (product.status !== 'archived') return res.status(400).json({ error: 'Only archived products can be permanently deleted' });

  await deleteFromR2(product.imageNames || []);
  await product.deleteOne();

  res.json({ message: 'Product permanently deleted' });
});

/**
 * Cleanup job: delete archived products older than 30 days
 * including their images from Cloudflare R2.
 */
async function runArchiveCleanup() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  const old = await Product.find({ status: 'archived', archivedAt: { $lt: cutoff } });
  if (!old.length) return;

  console.log(`Archive cleanup: removing ${old.length} products older than 30 days`);
  for (const product of old) {
    await deleteFromR2(product.imageNames || []);
    await product.deleteOne();
  }
}

module.exports = { router, runArchiveCleanup };
