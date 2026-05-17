const express = require('express');
const mongoose = require('mongoose');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const Product = require('../models/Product');
const Block = require('../models/Block');
const { shiftUp } = require('../utils/shiftOrderNumbers');
const { getIO } = require('../socket');
const { telegramAuth, requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');

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
router.get('/', asyncHandler(async (req, res) => {
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
}));

/**
 * POST /api/archive/:id/restore
 * Restore an archived product back to active status.
 */
router.post('/:id/restore', asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();
  let product;
  try {
    await session.withTransaction(async () => {
      product = await Product.findById(req.params.id).session(session);
      if (!product) throw appError('product_not_found');
      if (product.status !== 'archived') throw appError('product_not_archived');

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
      product.source = 'receive';
      product.orderNumber = restoreOrder;
      await product.save({ session });
    });
  } finally {
    await session.endSession();
  }

  try { getIO().emit('incoming_updated'); } catch (e) { console.warn('[archive/restore] socket incoming_updated failed:', e.message); }

  res.json(product);
}));

/**
 * DELETE /api/archive/:id — DISABLED.
 * Permanent deletion from the archive is intentionally not allowed to prevent
 * irreversible silent data loss. Archived products may only be RESTORED.
 */
router.delete('/:id', asyncHandler(async (req, res) => { // eslint-disable-line no-unused-vars
  throw appError('archive_delete_disabled');
}));

module.exports = { router };
