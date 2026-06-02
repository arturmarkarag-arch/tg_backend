'use strict';

const crypto      = require('crypto');
const router      = require('express').Router();
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { asyncHandler }         = require('../utils/errors');
const Product        = require('../models/Product');
const ProductVector  = require('../models/ProductVector');
const Block          = require('../models/Block');
const VisionTestLog  = require('../models/VisionTestLog');
const AppSetting     = require('../models/AppSetting');
const { getOpenAIStatus } = require('../openaiClient');
const { getGeminiStatus, embedImageUrl: geminiEmbedImageUrl, embedText: geminiEmbedText } = require('../geminiClient');
const { embedProduct } = require('../utils/productEmbedding');
const { describeImageUrl } = require('../utils/productDescribe');
const { presignPutUrl, deleteObject, publicUrl } = require('../utils/r2');

// One-shot query photos live here; deleted right after OpenAI reads them.
const VISION_TMP_FOLDER = 'vision-tmp';
function isVisionTmpKey(key) {
  return typeof key === 'string' && key.startsWith(`${VISION_TMP_FOLDER}/`) && !key.includes('..');
}

// Atlas Vector Search index — built on the geminiVector path of the productvectors
// collection (see models/ProductVector.js). ONE index serves every search: a hit is
// resolved back to its Product / ShopProduct afterwards. Gemini-only — OpenAI was
// retired at the 2026-06-03 cutover (the vector now lives in its own collection).
const VECTOR_INDEX = 'gemini_vector';

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

// Resolve a vector hit (a ProductVector row) to its catalogue ShopProduct: a warehouse
// MIRROR via linkedProductId == productId, or a SHOP-OWNED item via _id == shopProductId.
// `proj` is the inner $project (light card fields vs the full doc, minus vectors).
function shopResolveLookup(proj, as = 'sp') {
  return {
    $lookup: {
      from: 'shopproducts',
      let: { pid: '$productId', sid: '$shopProductId' },
      pipeline: [
        { $match: { $expr: { $or: [{ $eq: ['$linkedProductId', '$$pid'] }, { $eq: ['$_id', '$$sid'] }] } } },
        { $project: proj },
      ],
      as,
    },
  };
}

// Ranks the catalogue against a query vector via Atlas $vectorSearch over productvectors,
// then resolves each hit to its ShopProduct. Atlas cosine score is (1+cos)/2, converted
// back to raw cosine so the % matches the test-page meter.
async function searchByGeminiVector(embedding, k = 5) {
  const rows = await ProductVector.aggregate([
    { $vectorSearch: { index: VECTOR_INDEX, path: 'geminiVector', queryVector: embedding, numCandidates: Math.max(100, k * 20), limit: k } },
    { $addFields: { score: { $meta: 'vectorSearchScore' } } },
    shopResolveLookup({ name: 1, barcode: 1, price: 1, imageUrl: 1 }),
    { $unwind: '$sp' },
    { $project: { _id: '$sp._id', name: '$sp.name', barcode: '$sp.barcode', price: '$sp.price', imageUrl: '$sp.imageUrl', score: 1 } },
  ]);
  return rows.map((p) => toResultItem(p, 2 * (p.score || 0) - 1));
}

// ─── POST /embed-all — backfill warehouse vectors into productvectors ─────────
// Admin-only. Body/query: { force?, limit? }. Embeds a batch of WAREHOUSE products
// that have a photo but no ProductVector row yet (mirrors reference the warehouse
// row; shop-owned items embed on their own write). Returns counts so the client can
// loop until `remaining` hits zero. For the full backfill prefer
// server/scripts/reindexGemini.js — it paces requests under the free-tier limit.
router.post('/embed-all', adminOnly, asyncHandler(async (req, res) => {
  if (!getGeminiStatus().connected) {
    return res.status(503).json({ error: 'gemini_not_configured', message: getGeminiStatus().error || 'Gemini не підключено' });
  }

  const force = req.body?.force === true || req.query.force === 'true';
  const limit = Math.min(25, Math.max(1, parseInt(req.body?.limit ?? req.query.limit, 10) || 10));

  const haveIds = new Set(
    (await ProductVector.find({ productId: { $exists: true } }, 'productId').lean()).map((v) => String(v.productId)),
  );
  const candidates = await Product.find(
    { status: { $ne: 'archived' }, $or: [{ originalImageUrl: { $ne: '' } }, { 'imageUrls.0': { $exists: true } }] },
    '_id originalImageUrl imageUrls localImageUrl',
  ).lean();
  const todo = candidates.filter((p) => force || !haveIds.has(String(p._id))).slice(0, limit);

  let processed = 0, failed = 0;
  for (const p of todo) {
    try { if (await embedProduct(p, { force })) processed++; else failed++; }
    catch (err) { console.error('[visionSearch] embed-all failed for', String(p._id), err.message); failed++; }
  }
  const embedded  = await ProductVector.countDocuments({ productId: { $exists: true } });
  const remaining = Math.max(0, candidates.length - embedded);
  res.json({ provider: 'gemini', processed, failed, remaining, embedded });
}));

// ─── POST /query-vector — photo similarity search (Gemini) ────────────────────
// Body: { key, threshold? }. The query photo was uploaded straight to R2 (vision-tmp/);
// Gemini reads it by URL (no bytes through us), then we delete it. The photo's pixels
// become a vector directly (native multimodal) and rank the catalogue via Atlas
// $vectorSearch over productvectors. Allowed for sellers (PhotoSearchModal).
router.post('/query-vector', anyRole, asyncHandler(async (req, res) => {
  const key = req.body?.key;
  if (!isVisionTmpKey(key)) return res.status(400).json({ error: 'photo_required', message: 'Не вказано фото' });

  if (!getGeminiStatus().connected) {
    return res.status(503).json({ error: 'gemini_not_configured', message: getGeminiStatus().error || 'Gemini не підключено' });
  }

  // Client may override (test page slider); otherwise use the admin setting.
  const clientThreshold = req.body.threshold != null && req.body.threshold !== ''
    ? parseFloat(req.body.threshold) : NaN;
  const threshold = Number.isFinite(clientThreshold)
    ? Math.min(1, Math.max(0, clientThreshold))
    : await getVisionThreshold();

  const reasoning = 'Google Gemini Embadded 2 API мультимодальний векторний пошук.';
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const imageUrl = publicUrl(key);
  try {
    let embedding = null;
    try {
      const g = await geminiEmbedImageUrl(imageUrl);
      embedding = g.embedding;
    } catch (err) {
      console.error('[visionSearch] query-vector Gemini error:', err.message);
      return res.status(502).json({ error: 'gemini_api_error', message: err.message });
    }

    if (!embedding) {
      return res.json({ provider: 'gemini', threshold, reasoning, results: [], usage });
    }

    let resultItems;
    try {
      resultItems = await searchByGeminiVector(embedding, 5);
    } catch (err) {
      console.error('[visionSearch] vector search error:', err.message);
      return res.status(502).json({
        error:   'vector_search_failed',
        message: `Векторний пошук недоступний — перевір Atlas-індекс "${VECTOR_INDEX}". (${err.message})`,
      });
    }

    const log = await VisionTestLog.create({
      results:   resultItems.map((r) => ({ assetId: r.assetId, score: r.score, shopProduct: r.shopProduct._id })),
      reasoning,
      threshold,
      createdBy: req.telegramUser?.username || req.telegramUser?.id || '',
    });

    res.json({ logId: log._id, provider: 'gemini', threshold, reasoning, results: resultItems, usage });
  } finally {
    deleteObject(key); // one-shot photo — remove from R2 regardless of outcome
  }
}));

// Attaches each warehouse product's shelf location ({ blockId, position, total })
// so search results can show WHERE the item is. Products not on any shelf get null.
async function attachWarehouseLocations(items) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const objIds = items.map((i) => i._id);
  const blocks = await Block.find({ productIds: { $in: objIds } }, 'blockId productIds').lean();
  const locByProduct = new Map();
  for (const b of blocks) {
    const pids = (b.productIds || []).map(String);
    pids.forEach((pid, idx) => {
      if (!locByProduct.has(pid)) locByProduct.set(pid, { blockId: b.blockId, position: idx + 1, total: pids.length });
    });
  }
  for (const it of items) it.location = locByProduct.get(String(it._id)) || null;
  return items;
}

// ─── POST /query-text — semantic TEXT → IMAGE search (Gemini) ─────────────────
// The multimodal payoff: a typed word ("рукавички", "піца") is embedded with
// gemini-embedding-2 and matched against the catalog's IMAGE vectors in the same
// space — so it finds the product photo even with no name/description text. Gemini
// only; returns FULL ShopProduct docs ordered by similarity (so the catalog list
// can render + edit them like a normal page).
// Allowed for sellers — they read-only browse the same paginated results.
//
// Pagination: we rank up to TOP_K_CAP candidates by similarity once, then the
// client pages through that ordered top-K with offset/limit. Atlas $vectorSearch
// has no native $skip, so the cap + $facet pattern is the standard trick.
router.post('/query-text', anyRole, asyncHandler(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text_required', message: 'Порожній запит' });

  if (!getGeminiStatus().connected) {
    return res.status(503).json({ error: 'gemini_not_configured', message: getGeminiStatus().error || 'Gemini не підключено' });
  }

  const TOP_K_CAP = 200;
  const limit  = Math.min(50, Math.max(1, parseInt(req.body?.limit, 10) || 20));
  const offset = Math.min(TOP_K_CAP, Math.max(0, parseInt(req.body?.offset, 10) || 0));

  // Which catalog to search: shopproducts (Товари Магазинів, default) | products (Товари Складу).
  const collection = String(req.body?.collection || 'shopproducts').toLowerCase() === 'products' ? 'products' : 'shopproducts';

  let embedding = null;
  try {
    const e = await geminiEmbedText(text);
    embedding = e.embedding;
  } catch (err) {
    console.error('[visionSearch] query-text Gemini error:', err.message);
    return res.status(502).json({ error: 'gemini_api_error', message: err.message });
  }
  if (!embedding) return res.json({ items: [], total: 0, offset, limit });

  // Rank productvectors, then resolve each hit to its FULL doc (so the catalog list
  // can render + edit it). Hits that don't resolve (e.g. a deleted mirror) drop out.
  const resolve = collection === 'products'
    ? [
        { $match: { productId: { $exists: true } } },
        { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'doc', pipeline: [{ $project: { geminiVector: 0 } }] } },
      ]
    : [shopResolveLookup({ geminiVector: 0, embedding: 0, descriptor: 0 }, 'doc')];

  let result;
  try {
    result = await ProductVector.aggregate([
      { $vectorSearch: { index: VECTOR_INDEX, path: 'geminiVector', queryVector: embedding, numCandidates: Math.max(200, TOP_K_CAP * 10), limit: TOP_K_CAP } },
      { $addFields: { _score: { $meta: 'vectorSearchScore' } } },
      ...resolve,
      { $unwind: '$doc' },
      { $replaceRoot: { newRoot: { $mergeObjects: ['$doc', { _score: '$_score' }] } } },
      { $facet: {
          items:  [{ $skip: offset }, { $limit: limit }],
          counts: [{ $count: 'total' }],
      } },
    ]);
  } catch (err) {
    console.error('[visionSearch] query-text vector search error:', err.message);
    return res.status(502).json({
      error:   'vector_search_failed',
      message: `Векторний пошук недоступний — перевір Atlas-індекс "${VECTOR_INDEX}". (${err.message})`,
    });
  }

  const items = result?.[0]?.items || [];
  const total = result?.[0]?.counts?.[0]?.total || 0;

  if (collection === 'products') await attachWarehouseLocations(items);
  res.json({ items, total, offset, limit });
}));

// ─── POST /query-vector-warehouse — photo search over WAREHOUSE products ──────
// Body: { key, limit? }. Photo → Gemini vector → $vectorSearch over productvectors,
// keeping only warehouse rows (productId) and resolving each back to its full Product
// doc (rendered straight into the Товари Складу list). Gemini-only.
router.post('/query-vector-warehouse', staffOnly, asyncHandler(async (req, res) => {
  const key = req.body?.key;
  if (!isVisionTmpKey(key)) return res.status(400).json({ error: 'photo_required', message: 'Не вказано фото' });

  if (!getGeminiStatus().connected) {
    return res.status(503).json({ error: 'gemini_not_configured', message: getGeminiStatus().error || 'Gemini не підключено' });
  }

  const limit = Math.min(50, Math.max(1, parseInt(req.body?.limit, 10) || 20));
  const imageUrl = publicUrl(key);
  try {
    let embedding = null;
    try {
      const g = await geminiEmbedImageUrl(imageUrl);
      embedding = g.embedding;
    } catch (err) {
      console.error('[visionSearch] warehouse photo Gemini error:', err.message);
      return res.status(502).json({ error: 'gemini_api_error', message: err.message });
    }
    if (!embedding) return res.json({ items: [], total: 0 });

    let items;
    try {
      items = await ProductVector.aggregate([
        { $vectorSearch: { index: VECTOR_INDEX, path: 'geminiVector', queryVector: embedding, numCandidates: Math.max(100, limit * 20), limit } },
        { $match: { productId: { $exists: true } } },
        { $addFields: { _score: { $meta: 'vectorSearchScore' } } },
        { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'doc', pipeline: [{ $project: { geminiVector: 0 } }] } },
        { $unwind: '$doc' },
        { $replaceRoot: { newRoot: { $mergeObjects: ['$doc', { _score: '$_score' }] } } },
      ]);
    } catch (err) {
      console.error('[visionSearch] warehouse photo vector search error:', err.message);
      return res.status(502).json({
        error:   'vector_search_failed',
        message: `Векторний пошук по складу недоступний — перевір Atlas-індекс "${VECTOR_INDEX}". (${err.message})`,
      });
    }
    await attachWarehouseLocations(items);
    res.json({ items, total: items.length });
  } finally {
    deleteObject(key); // one-shot photo
  }
}));

// ─── POST /describe — plain-language product explainer (all roles) ────────────
// For staff/sellers who scan a product they don't recognise. No search, no
// embedding — just a friendly Ukrainian description of the photo.
router.post('/describe', anyRole, asyncHandler(async (req, res) => {
  const key = req.body?.key;
  if (!isVisionTmpKey(key)) return res.status(400).json({ error: 'photo_required', message: 'Не вказано фото' });

  if (!getGeminiStatus().connected && !getOpenAIStatus().connected) {
    return res.status(503).json({ error: 'describe_not_configured', message: 'Опис недоступний: не підключено ні Gemini, ні OpenAI' });
  }

  try {
    const { text, usage } = await describeImageUrl(publicUrl(key));
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
