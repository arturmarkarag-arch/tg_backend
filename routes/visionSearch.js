'use strict';

const router      = require('express').Router();
const multer      = require('multer');
const mongoose    = require('mongoose');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { asyncHandler }         = require('../utils/errors');
const ShopProduct    = require('../models/ShopProduct');
const VisionTestLog  = require('../models/VisionTestLog');
const { identifyProductFromPhoto, getOpenAIStatus, describeProductImage, embedText } = require('../openaiClient');

const staffOnly = requireTelegramRoles(['admin', 'warehouse']);
const adminOnly = requireTelegramRoles(['admin']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

// ─── Vector helpers ─────────────────────────────────────────────────────────
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function fetchImageBuffer(url) {
  // Hard timeout so a slow/dead image URL can't stall the whole embed request.
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`image fetch ${r.status}`);
  return { buffer: Buffer.from(await r.arrayBuffer()), mimeType: r.headers.get('content-type') || 'image/jpeg' };
}

// ─── POST /query ──────────────────────────────────────────────────────────────
router.post('/query', staffOnly, upload.single('photo'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'photo_required' });

  const status = getOpenAIStatus();
  if (!status.connected) {
    return res.status(503).json({
      error:   'openai_not_configured',
      message: status.error || 'OpenAI не підключено — перевірте OPENAI_API_KEY в налаштуваннях',
    });
  }

  const threshold = Math.min(1, Math.max(0, parseFloat(req.body.threshold) || 0));
  const detail = ['low', 'high', 'auto'].includes(req.body.detail) ? req.body.detail : 'low';

  const allProducts = await ShopProduct
    .find({}, { _id: 1, name: 1, barcode: 1, price: 1, imageUrl: 1 })
    .lean();

  let aiResult;
  try {
    aiResult = await identifyProductFromPhoto(req.file.buffer, req.file.mimetype, allProducts, { detail });
  } catch (err) {
    console.error('[visionSearch] OpenAI error:', err.message);
    return res.status(502).json({ error: 'openai_api_error', message: err.message });
  }

  const productMap = Object.fromEntries(allProducts.map((p) => [p._id.toString(), p]));

  const resultItems = (aiResult.candidates || [])
    .filter((c) => c.productId && mongoose.isValidObjectId(String(c.productId)))
    .map((c) => ({
      assetId:     String(c.productId),
      score:       Math.min(1, Math.max(0, Number(c.confidence) || 0)),
      shopProduct: productMap[String(c.productId)] || null,
    }));

  const log = await VisionTestLog.create({
    results: resultItems.map((r) => ({
      assetId:     r.assetId,
      score:       r.score,
      shopProduct: r.shopProduct?._id || null,
    })),
    reasoning: aiResult.reasoning || '',
    threshold,
    createdBy: req.telegramUser?.username || req.telegramUser?.id || '',
  });

  res.json({
    logId:     log._id,
    threshold,
    reasoning: aiResult.reasoning || '',
    results:   resultItems,
    usage:     aiResult.usage || {},
  });
}));

// ─── POST /embed-all — backfill descriptors + embeddings for the catalog ──────
// Admin-only. Processes a batch of products that have a photo but no embedding
// yet (or all, when force=true). Returns counts so the client can loop until
// `remaining` hits zero. Heavy (1 vision + 1 embedding call per product), so the
// per-call batch is capped.
router.post('/embed-all', adminOnly, asyncHandler(async (req, res) => {
  const status = getOpenAIStatus();
  if (!status.connected) {
    return res.status(503).json({ error: 'openai_not_configured', message: status.error || 'OpenAI не підключено' });
  }
  const force = req.body?.force === true || req.query.force === 'true';
  const limit = Math.min(25, Math.max(1, parseInt(req.body?.limit ?? req.query.limit, 10) || 10));

  const filter = { imageUrl: { $ne: '' } };
  if (!force) filter.embedding = { $exists: false };

  const docs = await ShopProduct.find(filter).limit(limit);
  let processed = 0, failed = 0;
  for (const doc of docs) {
    try {
      const { buffer, mimeType } = await fetchImageBuffer(doc.originalImageUrl || doc.imageUrl);
      const { descriptor } = await describeProductImage(buffer, mimeType);
      const { embedding, model } = await embedText(descriptor);
      if (!embedding) { failed++; continue; }
      doc.descriptor     = descriptor;
      doc.embedding      = embedding;
      doc.embeddingModel = model;
      doc.embeddedAt     = new Date();
      await doc.save();
      processed++;
    } catch (err) {
      console.error('[visionSearch] embed-all failed for', String(doc._id), err.message);
      failed++;
    }
  }
  const remaining = await ShopProduct.countDocuments({ imageUrl: { $ne: '' }, embedding: { $exists: false } });
  const embedded  = await ShopProduct.countDocuments({ embedding: { $exists: true } });
  res.json({ processed, failed, remaining, embedded });
}));

// ─── POST /query-vector — cosine similarity search over embeddings ────────────
// Describes the query photo, embeds the description, and ranks the catalog by
// cosine similarity in-process. No Atlas index required; swap to $vectorSearch
// when the catalog outgrows in-memory scoring.
router.post('/query-vector', staffOnly, upload.single('photo'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'photo_required' });

  const status = getOpenAIStatus();
  if (!status.connected) {
    return res.status(503).json({ error: 'openai_not_configured', message: status.error || 'OpenAI не підключено' });
  }

  const threshold = Math.min(1, Math.max(0, parseFloat(req.body.threshold) || 0));

  let descriptor = '', embedding = null, usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  try {
    const d = await describeProductImage(req.file.buffer, req.file.mimetype);
    descriptor = d.descriptor;
    usage.inputTokens  += Number(d.usage?.inputTokens  || 0);
    usage.outputTokens += Number(d.usage?.outputTokens || 0);
    const e = await embedText(descriptor);
    embedding = e.embedding;
    usage.inputTokens += Number(e.usage?.inputTokens || 0);
    usage.totalTokens  = usage.inputTokens + usage.outputTokens;
  } catch (err) {
    console.error('[visionSearch] query-vector OpenAI error:', err.message);
    return res.status(502).json({ error: 'openai_api_error', message: err.message });
  }

  if (!embedding) {
    return res.json({ threshold, reasoning: descriptor, results: [], usage });
  }

  const catalog = await ShopProduct
    .find({ embedding: { $exists: true } }, { name: 1, barcode: 1, price: 1, imageUrl: 1, embedding: 1 })
    .lean();

  const resultItems = catalog
    .map((p) => ({
      assetId:     String(p._id),
      score:       Math.max(0, Math.min(1, cosineSimilarity(embedding, p.embedding))),
      shopProduct: { _id: p._id, name: p.name, barcode: p.barcode, price: p.price, imageUrl: p.imageUrl },
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const log = await VisionTestLog.create({
    results:   resultItems.map((r) => ({ assetId: r.assetId, score: r.score, shopProduct: r.shopProduct._id })),
    reasoning: descriptor,
    threshold,
    createdBy: req.telegramUser?.username || req.telegramUser?.id || '',
  });

  res.json({ logId: log._id, threshold, reasoning: descriptor, results: resultItems, usage });
}));

// ─── GET /logs ────────────────────────────────────────────────────────────────
router.get('/logs', staffOnly, asyncHandler(async (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  const skip  = parseInt(req.query.skip, 10) || 0;

  const [logs, total] = await Promise.all([
    VisionTestLog.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('results.shopProduct', 'name price imageUrl barcode')
      .lean(),
    VisionTestLog.countDocuments(),
  ]);

  res.json({ logs, total });
}));

// ─── PATCH /logs/:id ──────────────────────────────────────────────────────────
router.patch('/logs/:id', staffOnly, asyncHandler(async (req, res) => {
  const { markedCorrect, note } = req.body;
  const log = await VisionTestLog.findByIdAndUpdate(
    req.params.id,
    { $set: { markedCorrect, note: note ?? '' } },
    { new: true, runValidators: false },
  ).lean();
  if (!log) return res.status(404).json({ error: 'log_not_found' });
  res.json(log);
}));

// ─── DELETE /logs ─────────────────────────────────────────────────────────────
router.delete('/logs', adminOnly, asyncHandler(async (req, res) => {
  const { deletedCount } = await VisionTestLog.deleteMany({});
  res.json({ deletedCount });
}));

module.exports = router;
