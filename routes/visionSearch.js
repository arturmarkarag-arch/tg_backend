'use strict';

const crypto      = require('crypto');
const router      = require('express').Router();
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { asyncHandler }         = require('../utils/errors');
const ShopProduct    = require('../models/ShopProduct');
const VisionTestLog  = require('../models/VisionTestLog');
const AppSetting     = require('../models/AppSetting');
const { getOpenAIStatus, describeProductImageUrl, explainProductImageUrl, embedText } = require('../openaiClient');
const { getGeminiStatus, embedImageUrl: geminiEmbedImageUrl } = require('../geminiClient');
const { embedShopProduct } = require('../utils/shopProductEmbedding');
const { presignPutUrl, deleteObject, publicUrl } = require('../utils/r2');

// One-shot query photos live here; deleted right after OpenAI reads them.
const VISION_TMP_FOLDER = 'vision-tmp';
function isVisionTmpKey(key) {
  return typeof key === 'string' && key.startsWith(`${VISION_TMP_FOLDER}/`) && !key.includes('..');
}

// Atlas Vector Search index names — must exist on the shopproducts collection
// (no fallback; the query errors clearly if it's missing). The OpenAI index is
// on `embedding` (1536); the Gemini index is on `geminiVector` (3072).
const VECTOR_INDEX        = 'shopproduct_vector';
const VECTOR_INDEX_GEMINI = 'shopproduct_gemini_vector';

// Which embedding provider answers a search. Resolves a per-request override
// (test page) first, then the admin setting, then the safe default (openai).
// Flip the AppSetting to 'gemini' to cut the whole app over after validation.
const SEARCH_PROVIDER_KEY     = 'vision.searchProvider';
// Default provider when neither a per-request override nor the AppSetting is set.
// Env-driven so the global cutover is just VISION_SEARCH_PROVIDER=gemini + restart
// (the AppSetting, if present, still wins over this).
const DEFAULT_SEARCH_PROVIDER =
  ['gemini', 'openai'].includes(String(process.env.VISION_SEARCH_PROVIDER || '').toLowerCase())
    ? process.env.VISION_SEARCH_PROVIDER.toLowerCase()
    : 'openai';
async function getSearchProvider(override) {
  const o = String(override || '').toLowerCase();
  if (o === 'gemini' || o === 'openai') return o;
  const s = await AppSetting.findOne({ key: SEARCH_PROVIDER_KEY }).lean();
  const v = String(s?.value || '').toLowerCase();
  return v === 'gemini' || v === 'openai' ? v : DEFAULT_SEARCH_PROVIDER;
}

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

// ─── GET /upload-url — presigned PUT for a one-shot query photo ───────────────
// Browser uploads the photo straight to R2; the bytes never touch our server.
router.get('/upload-url', anyRole, asyncHandler(async (req, res) => {
  const key = `${VISION_TMP_FOLDER}/${crypto.randomUUID()}.jpg`;
  const uploadUrl = await presignPutUrl(key, 'image/jpeg');
  res.json({ uploadUrl, key });
}));

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

// Same as searchByVector but against the Gemini index/field. gemini-embedding-2
// auto-normalizes its output, so cosine in Atlas behaves the same — we reuse the
// (1+cos)/2 → cos conversion so the % meter stays consistent across providers.
async function searchByGeminiVector(embedding, k = 5) {
  const docs = await ShopProduct.aggregate([
    {
      $vectorSearch: {
        index:         VECTOR_INDEX_GEMINI,
        path:          'geminiVector',
        queryVector:   embedding,
        numCandidates: Math.max(100, k * 20),
        limit:         k,
      },
    },
    { $project: { name: 1, barcode: 1, price: 1, imageUrl: 1, score: { $meta: 'vectorSearchScore' } } },
  ]);
  return docs.map((p) => toResultItem(p, 2 * (p.score || 0) - 1));
}

// ─── POST /embed-all — backfill embeddings for the catalog ────────────────────
// Admin-only. Body/query: { provider?: 'gemini'|'openai', force?, limit? }.
// Processes a batch of products that have a photo but no vector yet for the
// chosen provider (or all, when force=true). Returns counts so the client can
// loop until `remaining` hits zero. Defaults to Gemini (the new primary). For
// the full 2000-item backfill prefer server/scripts/reindexGemini.js — it paces
// requests under the 60 req/min free-tier limit; this endpoint is for small,
// incremental top-ups from the admin UI.
router.post('/embed-all', adminOnly, asyncHandler(async (req, res) => {
  const provider = String(req.body?.provider || req.query.provider || 'gemini').toLowerCase() === 'openai'
    ? 'openai' : 'gemini';

  if (provider === 'openai' && !getOpenAIStatus().connected) {
    return res.status(503).json({ error: 'openai_not_configured', message: getOpenAIStatus().error || 'OpenAI не підключено' });
  }
  if (provider === 'gemini' && !getGeminiStatus().connected) {
    return res.status(503).json({ error: 'gemini_not_configured', message: getGeminiStatus().error || 'Gemini не підключено' });
  }

  const force = req.body?.force === true || req.query.force === 'true';
  const limit = Math.min(25, Math.max(1, parseInt(req.body?.limit ?? req.query.limit, 10) || 10));
  const field = provider === 'gemini' ? 'geminiVector' : 'embedding';

  const filter = { imageUrl: { $ne: '' } };
  if (!force) filter[field] = { $exists: false };

  const docs = await ShopProduct.find(filter).limit(limit);
  let processed = 0, failed = 0;
  for (const doc of docs) {
    try {
      if (await embedShopProduct(doc, { providers: [provider] })) processed++; else failed++;
    } catch (err) {
      console.error('[visionSearch] embed-all failed for', String(doc._id), err.message);
      failed++;
    }
  }
  const remaining = await ShopProduct.countDocuments({ imageUrl: { $ne: '' }, [field]: { $exists: false } });
  const embedded  = await ShopProduct.countDocuments({ [field]: { $exists: true } });
  res.json({ provider, processed, failed, remaining, embedded });
}));

// ─── POST /query-vector — embedding similarity search ─────────────────────────
// Body: { key, threshold? }. The query photo was uploaded straight to R2 (vision-tmp/);
// OpenAI reads it by URL (no bytes through us), then we delete it. Describes the
// photo, embeds it, and ranks the catalog via Atlas $vectorSearch (no fallback).
router.post('/query-vector', staffOnly, asyncHandler(async (req, res) => {
  const key = req.body?.key;
  if (!isVisionTmpKey(key)) return res.status(400).json({ error: 'photo_required', message: 'Не вказано фото' });

  const provider = await getSearchProvider(req.body?.provider);

  // Client may override (test page slider); otherwise use the admin setting.
  const clientThreshold = req.body.threshold != null && req.body.threshold !== ''
    ? parseFloat(req.body.threshold) : NaN;
  const threshold = Number.isFinite(clientThreshold)
    ? Math.min(1, Math.max(0, clientThreshold))
    : await getVisionThreshold();

  const imageUrl = publicUrl(key);
  try {
    let reasoning = '', embedding = null, usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    if (provider === 'gemini') {
      if (!getGeminiStatus().connected) {
        return res.status(503).json({ error: 'gemini_not_configured', message: getGeminiStatus().error || 'Gemini не підключено' });
      }
      try {
        // Native multimodal: the query photo's pixels become a vector directly —
        // no intermediate text description, hence no "reasoning" to show.
        const g = await geminiEmbedImageUrl(imageUrl);
        embedding = g.embedding;
        reasoning = 'Gemini multimodal — вектор напряму з фото (без проміжного опису)';
      } catch (err) {
        console.error('[visionSearch] query-vector Gemini error:', err.message);
        return res.status(502).json({ error: 'gemini_api_error', message: err.message });
      }
    } else {
      if (!getOpenAIStatus().connected) {
        return res.status(503).json({ error: 'openai_not_configured', message: getOpenAIStatus().error || 'OpenAI не підключено' });
      }
      try {
        const d = await describeProductImageUrl(imageUrl);
        reasoning = d.descriptor;
        usage.inputTokens  += Number(d.usage?.inputTokens  || 0);
        usage.outputTokens += Number(d.usage?.outputTokens || 0);
        const e = await embedText(d.descriptor);
        embedding = e.embedding;
        usage.inputTokens += Number(e.usage?.inputTokens || 0);
        usage.totalTokens  = usage.inputTokens + usage.outputTokens;
      } catch (err) {
        console.error('[visionSearch] query-vector OpenAI error:', err.message);
        return res.status(502).json({ error: 'openai_api_error', message: err.message });
      }
    }

    if (!embedding) {
      return res.json({ provider, threshold, reasoning, results: [], usage });
    }

    const indexName = provider === 'gemini' ? VECTOR_INDEX_GEMINI : VECTOR_INDEX;
    let resultItems;
    try {
      resultItems = provider === 'gemini'
        ? await searchByGeminiVector(embedding, 5)
        : await searchByVector(embedding, 5);
    } catch (err) {
      console.error('[visionSearch] vector search error:', err.message);
      return res.status(502).json({
        error:   'vector_search_failed',
        message: `Векторний пошук недоступний — перевір Atlas-індекс "${indexName}". (${err.message})`,
      });
    }

    const log = await VisionTestLog.create({
      results:   resultItems.map((r) => ({ assetId: r.assetId, score: r.score, shopProduct: r.shopProduct._id })),
      reasoning,
      threshold,
      createdBy: req.telegramUser?.username || req.telegramUser?.id || '',
    });

    res.json({ logId: log._id, provider, threshold, reasoning, results: resultItems, usage });
  } finally {
    deleteObject(key); // one-shot photo — remove from R2 regardless of outcome
  }
}));

// ─── POST /describe — plain-language product explainer (all roles) ────────────
// For staff/sellers who scan a product they don't recognise. No search, no
// embedding — just a friendly Ukrainian description of the photo.
router.post('/describe', anyRole, asyncHandler(async (req, res) => {
  const key = req.body?.key;
  if (!isVisionTmpKey(key)) return res.status(400).json({ error: 'photo_required', message: 'Не вказано фото' });

  const status = getOpenAIStatus();
  if (!status.connected) {
    return res.status(503).json({ error: 'openai_not_configured', message: status.error || 'OpenAI не підключено' });
  }

  try {
    const { text, usage } = await explainProductImageUrl(publicUrl(key));
    res.json({ description: text, usage });
  } catch (err) {
    console.error('[visionSearch] describe error:', err.message);
    return res.status(502).json({ error: 'openai_api_error', message: err.message });
  } finally {
    deleteObject(key); // one-shot photo
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
