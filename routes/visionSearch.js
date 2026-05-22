'use strict';

const router      = require('express').Router();
const multer      = require('multer');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { asyncHandler }         = require('../utils/errors');
const ShopProduct    = require('../models/ShopProduct');
const VisionTestLog  = require('../models/VisionTestLog');
const AppSetting     = require('../models/AppSetting');
const { getOpenAIStatus, describeProductImage, explainProductImage, embedText } = require('../openaiClient');
const { embedShopProduct } = require('../utils/shopProductEmbedding');

// Atlas Vector Search index name — must exist on the shopproducts collection
// (no fallback; the query errors clearly if it's missing).
const VECTOR_INDEX = 'shopproduct_vector';

// Confidence threshold is admin-configurable (vision.threshold setting).
const VISION_THRESHOLD_KEY = 'vision.threshold';
const DEFAULT_THRESHOLD = 0.6;
async function getVisionThreshold() {
  const s = await AppSetting.findOne({ key: VISION_THRESHOLD_KEY }).lean();
  const v = Number(s?.value);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_THRESHOLD;
}

const staffOnly = requireTelegramRoles(['admin', 'warehouse']);
const adminOnly = requireTelegramRoles(['admin']);
const anyRole   = requireTelegramRoles(['admin', 'warehouse', 'seller']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

// ─── Vector helpers ─────────────────────────────────────────────────────────
function toResultItem(p, score) {
  return {
    assetId:     String(p._id),
    score:       Math.max(0, Math.min(1, score)),
    shopProduct: { _id: p._id, name: p.name, barcode: p.barcode, price: p.price, imageUrl: p.imageUrl },
  };
}

// Ranks the catalog against a query embedding via Atlas $vectorSearch. Requires
// the `shopproduct_vector` index to exist (no fallback). Atlas cosine score is
// (1+cos)/2, converted back to raw cosine so the % matches the test-page meter.
async function searchByVector(embedding, k = 5) {
  const docs = await ShopProduct.aggregate([
    {
      $vectorSearch: {
        index:         VECTOR_INDEX,
        path:          'embedding',
        queryVector:   embedding,
        numCandidates: Math.max(100, k * 20),
        limit:         k,
      },
    },
    { $project: { name: 1, barcode: 1, price: 1, imageUrl: 1, score: { $meta: 'vectorSearchScore' } } },
  ]);
  return docs.map((p) => toResultItem(p, 2 * (p.score || 0) - 1));
}

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
      if (await embedShopProduct(doc)) processed++; else failed++;
    } catch (err) {
      console.error('[visionSearch] embed-all failed for', String(doc._id), err.message);
      failed++;
    }
  }
  const remaining = await ShopProduct.countDocuments({ imageUrl: { $ne: '' }, embedding: { $exists: false } });
  const embedded  = await ShopProduct.countDocuments({ embedding: { $exists: true } });
  res.json({ processed, failed, remaining, embedded });
}));

// ─── POST /query-vector — embedding similarity search ─────────────────────────
// Describes the query photo, embeds the description, and ranks the catalog via
// Atlas $vectorSearch (requires the index — no fallback). See searchByVector.
router.post('/query-vector', staffOnly, upload.single('photo'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'photo_required' });

  const status = getOpenAIStatus();
  if (!status.connected) {
    return res.status(503).json({ error: 'openai_not_configured', message: status.error || 'OpenAI не підключено' });
  }

  // Client may override (test page slider); otherwise use the admin setting.
  const clientThreshold = req.body.threshold != null && req.body.threshold !== ''
    ? parseFloat(req.body.threshold) : NaN;
  const threshold = Number.isFinite(clientThreshold)
    ? Math.min(1, Math.max(0, clientThreshold))
    : await getVisionThreshold();

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

  let resultItems;
  try {
    resultItems = await searchByVector(embedding, 5);
  } catch (err) {
    console.error('[visionSearch] vector search error:', err.message);
    return res.status(502).json({
      error:   'vector_search_failed',
      message: `Векторний пошук недоступний — перевір Atlas-індекс "${VECTOR_INDEX}". (${err.message})`,
    });
  }

  const log = await VisionTestLog.create({
    results:   resultItems.map((r) => ({ assetId: r.assetId, score: r.score, shopProduct: r.shopProduct._id })),
    reasoning: descriptor,
    threshold,
    createdBy: req.telegramUser?.username || req.telegramUser?.id || '',
  });

  res.json({ logId: log._id, threshold, reasoning: descriptor, results: resultItems, usage });
}));

// ─── POST /describe — plain-language product explainer (all roles) ────────────
// For staff/sellers who scan a product they don't recognise. No search, no
// embedding — just a friendly Ukrainian description of the photo.
router.post('/describe', anyRole, upload.single('photo'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'photo_required' });

  const status = getOpenAIStatus();
  if (!status.connected) {
    return res.status(503).json({ error: 'openai_not_configured', message: status.error || 'OpenAI не підключено' });
  }

  try {
    const { text, usage } = await explainProductImage(req.file.buffer, req.file.mimetype);
    res.json({ description: text, usage });
  } catch (err) {
    console.error('[visionSearch] describe error:', err.message);
    return res.status(502).json({ error: 'openai_api_error', message: err.message });
  }
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
