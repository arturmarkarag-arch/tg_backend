const express = require('express');
const mongoose = require('mongoose');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const Product = require('../models/Product');
const { shiftUp } = require('../utils/shiftOrderNumbers');
const { getIO } = require('../socket');
const { telegramAuth, requireTelegramRoles } = require('../middleware/telegramAuth');

const router = express.Router();

router.use(telegramAuth);
router.use(requireTelegramRoles(['admin', 'warehouse']));

let _r2Client = null;
function getR2Client() {
  if (_r2Client) return _r2Client;
  const { R2_REGION, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 credentials are not configured (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY required)');
  }
  _r2Client = new S3Client({
    region: R2_REGION || 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    forcePathStyle: true,
  });
  return _r2Client;
}

async function deleteFromR2(imageNames = []) {
  if (!imageNames.length) return;
  let client;
  try {
    client = getR2Client();
  } catch (err) {
    console.error('[deleteFromR2] R2 not configured:', err.message);
    return;
  }
  for (const name of imageNames) {
    try {
      await client.send(new DeleteObjectCommand({
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
  const session = await mongoose.startSession();
  let product;
  try {
    await session.withTransaction(async () => {
      product = await Product.findById(req.params.id).session(session);
      if (!product) throw Object.assign(new Error('Product not found'), { status: 404 });
      if (product.status !== 'archived') throw Object.assign(new Error('Product is not archived'), { status: 400 });

      let restoreOrder;
      if (product.originalOrderNumber) {
        restoreOrder = product.originalOrderNumber;
        await shiftUp({ status: { $ne: 'archived' }, orderNumber: { $gte: restoreOrder } }, session);
      } else {
        const maxOrder = await Product.findOne({ status: { $ne: 'archived' } })
          .sort({ orderNumber: -1 })
          .select('orderNumber')
          .session(session)
          .lean();
        restoreOrder = (maxOrder?.orderNumber || 0) + 1;
      }

      product.status = 'active';
      product.archivedAt = null;
      product.originalOrderNumber = null;
      product.restoredFromArchive = true;
      product.source = 'receive'; // повертається в надходження, не в блок
      product.orderNumber = restoreOrder;
      await product.save({ session });
    });
  } catch (err) {
    await session.endSession();
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  await session.endSession();

  try { getIO().emit('incoming_updated'); } catch (_) {}

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

module.exports = { router };
