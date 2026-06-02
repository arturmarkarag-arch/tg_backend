const express = require('express');
const crypto  = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');
const ShopProduct = require('../models/ShopProduct');
const Product     = require('../models/Product');
const { embedShopProductAsync } = require('../utils/shopProductEmbedding');
const { explainProductImageUrl, getOpenAIStatus } = require('../openaiClient');
const { getGeminiStatus } = require('../geminiClient');
const { describeImageUrl } = require('../utils/productDescribe');

const staffOnly  = requireTelegramRoles(['admin', 'warehouse']);
const adminOnly  = requireTelegramRoles(['admin']);
// Read-only browse — sellers see the same catalogue but in a stripped-down,
// non-editable card on the page. Write endpoints below stay staff-only.
const anyRole    = requireTelegramRoles(['admin', 'warehouse', 'seller']);

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
router.get('/', anyRole, asyncHandler(async (req, res) => {
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
          { name:          new RegExp(t, 'i') },
          { barcode:       new RegExp(t, 'i') },
          { notes:         new RegExp(t, 'i') },
          { aiDescription: new RegExp(t, 'i') },
          { descriptor:    new RegExp(t, 'i') },
        ],
      }));
    }
  }

  const [total, items] = await Promise.all([
    ShopProduct.countDocuments(query),
    // Vectors are select:false; `descriptor` is the GPT embedding text (search-only,
    // never rendered) so drop it too — the card list stays tiny regardless of catalogue size.
    ShopProduct.find(query)
      .select('-descriptor')
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

// ── GET /:id — single ShopProduct by id ───────────────────────────────────────
// Used by the shop-products deep-link (?product=<shopProductId>): the page
// fetches the doc, pulls its barcode, and drops that into the search box.
router.get('/:id', anyRole, asyncHandler(async (req, res) => {
  const item = await ShopProduct.findById(req.params.id).lean();
  if (!item) throw appError('product_not_found');
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

  try {
    const item = await ShopProduct.create({
      barcode:            String(barcode || '').trim(),
      name:               String(name    || '').trim(),
      price:              Number(price)  || 0,
      quantityPerPackage: Number(quantityPerPackage) || 0,
      notes:              String(notes  || '').trim(),
      source:             ['receive', 'seller', 'manual'].includes(source) ? source : 'manual',
      createdBy:          String(req.telegramId || req.user?.telegramId || ''),
      imageUrl,
      originalImageUrl,
    });
    res.status(201).json(item);
    // Auto-index for vector search (background; needs a photo).
    if (item.imageUrl || item.originalImageUrl) embedShopProductAsync(item, 'create');
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'barcode_exists', message: 'Товар з таким штрихкодом вже існує' });
    }
    throw err;
  }
}));

// ── PATCH /:id — update ───────────────────────────────────────────────────────
// Shop Products is fully decoupled from the warehouse: edits here NEVER mutate
// the linked warehouse Product. (Any "recommendation" channel back to the
// warehouse will be a separate, explicit, non-authoritative mechanism.)
router.patch('/:id', staffOnly, asyncHandler(async (req, res) => {
  const item = await ShopProduct.findById(req.params.id);
  if (!item) throw appError('product_not_found');

  // A ShopProduct with a linkedProductId is a READ-ONLY MIRROR of a warehouse
  // Product. Its shared fields (name/price/qty/photo/notes) are owned by the
  // warehouse and pushed in via pushSharedFieldsToMirror — editing them here
  // would desync. Only shop-OWNED products (linkedProductId: null) are editable.
  if (item.linkedProductId) throw appError('shopproduct_edit_on_warehouse');

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

  const photoChanged = Boolean(fields.filename || fields.originalFilename);

  try {
    await item.save();
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'barcode_exists', message: 'Товар з таким штрихкодом вже існує' });
    }
    throw err;
  }

  res.json(item.toObject());
  // New photo → the old embedding is stale; re-index in the background.
  if (photoChanged && (item.imageUrl || item.originalImageUrl)) embedShopProductAsync(item, 'patch');
}));

// ── POST /:id/describe — generate + cache the human-friendly card description ──
// On-demand (staff presses the button). Uses the clean original photo and the
// plain-language Ukrainian explainer — distinct from the terse embedding
// `descriptor`. Result is cached in aiDescription; pressing again regenerates.
router.post('/:id/describe', staffOnly, asyncHandler(async (req, res) => {
  const item = await ShopProduct.findById(req.params.id);
  if (!item) throw appError('product_not_found');

  // A linked mirror's description is owned by the warehouse (pushed in via
  // pushSharedFieldsToMirror — same physical product, same description). Regenerate
  // it from the warehouse card; doing it here would diverge until the next push.
  if (item.linkedProductId) throw appError('shopproduct_edit_on_warehouse');

  const url = item.originalImageUrl || item.imageUrl;
  if (!url) return res.status(400).json({ error: 'photo_required', message: 'У товару немає фото' });

  if (!getGeminiStatus().connected && !getOpenAIStatus().connected) {
    return res.status(503).json({ error: 'describe_not_configured', message: 'Опис недоступний: не підключено ні Gemini, ні OpenAI' });
  }

  try {
    const { text, name: aiName } = await describeImageUrl(url);
    if (!text) return res.status(502).json({ error: 'empty_description', message: 'Не вдалося згенерувати опис' });
    item.aiDescription = text;
    if (aiName && !item.name) item.name = aiName;
    await item.save();
    res.json({ _id: item._id, aiDescription: item.aiDescription, aiName: aiName || null });
  } catch (err) {
    console.error('[shopProducts] describe error:', err.message);
    return res.status(502).json({ error: 'describe_api_error', message: err.message });
  }
}));

// ── DELETE /:id ───────────────────────────────────────────────────────────────
router.delete('/:id', staffOnly, asyncHandler(async (req, res) => {
  const item = await ShopProduct.findById(req.params.id).lean();
  if (!item) throw appError('product_not_found');

  // A LIVE mirror (linked to a non-archived warehouse Product) is warehouse-owned
  // and must not be deleted from here. But an ORPHANED mirror — whose warehouse
  // owner was archived/deleted — may be cleaned up (archiving the owner never
  // cascades to the mirror, so orphans can accumulate otherwise).
  if (item.linkedProductId) {
    const owner = await Product.findById(item.linkedProductId).select('status').lean();
    if (owner && owner.status !== 'archived') throw appError('shopproduct_edit_on_warehouse');
  }

  await ShopProduct.deleteOne({ _id: item._id });
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
