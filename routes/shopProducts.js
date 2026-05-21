const express = require('express');
const crypto  = require('crypto');
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');
const ShopProduct = require('../models/ShopProduct');
const Product     = require('../models/Product');

const staffOnly  = requireTelegramRoles(['admin', 'warehouse']);
const adminOnly  = requireTelegramRoles(['admin']);

const router = express.Router();

// ── R2 helpers (mirror products.js) ──────────────────────────────────────────
const s3Client = new S3Client({
  region:   process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

function r2PublicUrl(folder, filename) {
  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${folder}/${filename}`;
}

async function r2Delete(key) {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
  } catch (err) {
    console.error(`[shopProducts] r2Delete failed for ${key}:`, err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeRegex(v = '') {
  return String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeFilename(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9._-]/g, '');
}

// ── GET / — list with pagination + search ─────────────────────────────────────
router.get('/', staffOnly, asyncHandler(async (req, res) => {
  const limit  = Math.min(100, Math.max(1, Number(req.query.limit)  || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const query  = {};

  if (req.query.barcode) {
    query.barcode = String(req.query.barcode).trim();
  }

  if (req.query.search) {
    const terms = String(req.query.search).trim()
      .split(/\s+/).map(escapeRegex).filter(Boolean);
    if (terms.length) {
      query.$and = terms.map((t) => ({
        $or: [
          { name:    new RegExp(t, 'i') },
          { barcode: new RegExp(t, 'i') },
          { notes:   new RegExp(t, 'i') },
        ],
      }));
    }
  }

  const [total, items] = await Promise.all([
    ShopProduct.countDocuments(query),
    ShopProduct.find(query)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean(),
  ]);

  res.json({ items, total, offset, limit, hasMore: offset + items.length < total });
}));

// ── GET /barcode/:code — scanner lookup (public, no auth required) ────────────
router.get('/barcode/:code', asyncHandler(async (req, res) => {
  const code = String(req.params.code).trim();
  if (!code) throw appError('product_barcode_required');
  const item = await ShopProduct.findOne({ barcode: code }).lean();
  if (!item) return res.status(404).json({ error: 'not_found' });
  res.json(item);
}));

// ── POST / — create ───────────────────────────────────────────────────────────
router.post('/', staffOnly, asyncHandler(async (req, res) => {
  const { barcode, name, price, quantityPerPackage, notes, source, filename, originalFilename } = req.body;

  let imageUrl = '';
  let originalImageUrl = '';
  if (filename) {
    const safe = safeFilename(filename);
    if (safe) {
      imageUrl = r2PublicUrl('products', safe);
      originalImageUrl = imageUrl;
    }
  }
  if (originalFilename) {
    const safe = safeFilename(originalFilename);
    if (safe) originalImageUrl = r2PublicUrl('originals', safe);
  }

  const item = await ShopProduct.create({
    barcode:            String(barcode || '').trim(),
    name:               String(name    || '').trim(),
    price:              Number(price)  || 0,
    quantityPerPackage: Number(quantityPerPackage) || 0,
    notes:              String(notes  || '').trim(),
    source:             ['receive', 'seller', 'manual'].includes(source) ? source : 'manual',
    imageUrl,
    originalImageUrl,
  });
  res.status(201).json(item);
}));

// ── PATCH /:id — update ───────────────────────────────────────────────────────
// Uses a transaction when the record is linked to a warehouse Product so that
// shared fields (name, price) stay consistent across both collections atomically.
router.patch('/:id', staffOnly, asyncHandler(async (req, res) => {
  const item = await ShopProduct.findById(req.params.id);
  if (!item) throw appError('product_not_found');

  const fields = req.body;

  // ── Scalar fields ──────────────────────────────────────────────────────────
  if (fields.name               !== undefined) item.name               = String(fields.name).trim();
  if (fields.barcode            !== undefined) item.barcode            = String(fields.barcode).trim();
  if (fields.price              !== undefined) item.price              = Number(fields.price) || 0;
  if (fields.quantityPerPackage !== undefined) item.quantityPerPackage = Number(fields.quantityPerPackage) || 0;
  if (fields.notes              !== undefined) item.notes              = String(fields.notes).trim();
  if (fields.labelPositions     !== undefined) {
    const lp = fields.labelPositions;
    item.labelPositions = typeof lp === 'string' ? JSON.parse(lp) : lp;
  }

  // ── Photo: annotated canvas ────────────────────────────────────────────────
  if (fields.filename) {
    const safe = safeFilename(fields.filename);
    if (safe) item.imageUrl = r2PublicUrl('products', safe);
  }

  // ── Photo: raw original (uploaded separately by client before annotation) ──
  if (fields.originalFilename) {
    const safe = safeFilename(fields.originalFilename);
    if (safe) item.originalImageUrl = r2PublicUrl('originals', safe);
  } else if (!item.originalImageUrl && item.imageUrl) {
    // First ever annotation: promote current imageUrl as the clean base
    item.originalImageUrl = item.imageUrl;
  }

  // ── Transactional propagation to linked warehouse Product ─────────────────
  // Only name and price are considered "shared" between the two systems.
  const propagate = item.linkedProductId &&
    (fields.name !== undefined || fields.price !== undefined);

  if (propagate) {
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await item.save({ session });
        const updates = {};
        if (fields.name  !== undefined) updates.name  = item.name;
        if (fields.price !== undefined) updates.price = item.price;
        await Product.findByIdAndUpdate(item.linkedProductId, { $set: updates }, { session });
      });
    } finally {
      session.endSession();
    }
  } else {
    await item.save();
  }

  res.json(item.toObject());
}));

// ── DELETE /:id ───────────────────────────────────────────────────────────────
router.delete('/:id', staffOnly, asyncHandler(async (req, res) => {
  const item = await ShopProduct.findByIdAndDelete(req.params.id).lean();
  if (!item) throw appError('product_not_found');
  res.json({ ok: true });
}));

// ── POST /migrate-from-products — one-time admin migration ────────────────────
// Copies active warehouse Products into ShopProduct using findOneAndUpdate
// (upsert by barcode) so re-running is idempotent. Runs inside a single session
// with write batches to stay within the 60-second transaction limit.
router.post('/migrate-from-products', adminOnly, asyncHandler(async (req, res) => {
  const products = await Product.find({ status: { $ne: 'archived' } }).lean();
  let created = 0;
  let skipped = 0;

  for (const p of products) {
    const barcode = String(p.barcode || '').trim();
    const imageUrl = p.imageUrls?.[0] || p.localImageUrl || '';

    const doc = {
      name:               p.name || p.brand || p.model || p.category || '',
      price:              p.price || 0,
      quantityPerPackage: p.quantityPerPackage || 0,
      notes:              p.notes || '',
      originalImageUrl:   p.originalImageUrl || imageUrl,
      imageUrl,
      labelPositions:     p.labelPositions || {},
      source:             'receive',
      linkedProductId:    p._id,
    };

    // Upsert: match on barcode (if present) or linkedProductId
    const filter = barcode
      ? { barcode }
      : { linkedProductId: p._id };

    const result = await ShopProduct.findOneAndUpdate(
      filter,
      { $setOnInsert: { ...doc, barcode } },
      { upsert: true, new: false }
    );

    if (result === null) created++; else skipped++;
  }

  res.json({ ok: true, created, skipped, total: products.length });
}));

module.exports = router;
