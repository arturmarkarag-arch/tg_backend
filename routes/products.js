const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, HeadBucketCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { shiftUp, shiftDown } = require('../utils/shiftOrderNumbers');
const { normalizeBarcode } = require('../utils/barcodeScanner');
const Block = require('../models/Block');
const { getIO } = require('../socket');
const Product = require('../models/Product');
const ShopProduct = require('../models/ShopProduct');
const { upsertShopProductFromProduct, pushSharedFieldsToMirror } = require('../utils/upsertShopProduct');
const Order = require('../models/Order');
const User = require('../models/User');
const Shop = require('../models/Shop');
const DeliveryGroup = require('../models/DeliveryGroup');
const SearchProduct = require('../models/SearchProduct');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');
const { explainProductImageUrl, getOpenAIStatus } = require('../openaiClient');
const { getGeminiStatus } = require('../geminiClient');
const { describeImageUrl } = require('../utils/productDescribe');
const { embedProductAsync } = require('../utils/productEmbedding');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { normalizeDeliveryGroup } = require('../utils/deliveryGroupHelpers');
const cache = require('../utils/cache');

const staffOnly = requireTelegramRoles(['admin', 'warehouse']);

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const s3Client = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

(async () => {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: process.env.R2_BUCKET_NAME }));
    console.log('Cloudflare R2 bucket OK:', process.env.R2_BUCKET_NAME);
  } catch (err) {
    console.error('R2 bucket check failed:', err.message);
  }
})();

const ALLOWED_UPLOAD_FOLDERS = ['products', 'originals'];

// Product photos are content-addressed (UUID filenames never change), so they
// can be cached forever. Signed into the presigned PUTs and echoed by the
// client so the SigV4 signature matches; the R2 bucket CORS must allow the
// Cache-Control request header for the browser→R2 preflight to pass.
const UPLOAD_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function r2PublicUrl(folder, filename) {
  const base = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
  return `${base}/${folder}/${filename}`;
}

async function deleteR2Objects(keys = []) {
  for (const key of keys) {
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    } catch (err) {
      console.error(`[deleteR2Objects] Failed to delete ${key}:`, err.message);
    }
  }
}

function getProductTitle(product) {
  return product.name || product.brand || product.model || product.category || `#${product.orderNumber}`;
}

// Builds a productId(string) → { blockId, position, total } map for the given
// product ids, so the Товари Складу page can show — and deep-link to — where each
// item sits on the shelves. Mirrors attachWarehouseLocations() in visionSearch.js
// (semantic/photo search results already carry `location`); this brings the same
// info to the plain list + single-product fetch.
async function buildLocationMap(ids = []) {
  const map = new Map();
  if (!Array.isArray(ids) || ids.length === 0) return map;
  const blocks = await Block.find({ productIds: { $in: ids } }, 'blockId productIds').lean();
  for (const b of blocks) {
    const pids = (b.productIds || []).map(String);
    pids.forEach((pid, idx) => {
      if (!map.has(pid)) map.set(pid, { blockId: b.blockId, position: idx + 1, total: pids.length });
    });
  }
  return map;
}

const router = express.Router();

// GET /api/v1/products/upload-url?folder=products&ext=jpg — staff presigned PUT URL for direct browser→R2 upload
router.get('/upload-url', staffOnly, asyncHandler(async (req, res) => {
  const folder = String(req.query.folder || 'products');
  const safeFolder = ALLOWED_UPLOAD_FOLDERS.includes(folder) ? folder : 'products';
  const ext = String(req.query.ext || 'jpg').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const safeExt = ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : 'jpg';
  const filename = `${crypto.randomUUID()}.${safeExt}`;
  const key = `${safeFolder}/${filename}`;
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: 'image/jpeg',
    CacheControl: UPLOAD_CACHE_CONTROL,
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
  res.json({
    uploadUrl,
    filename,
    cacheControl: UPLOAD_CACHE_CONTROL,
    url: r2PublicUrl(safeFolder, filename),
    thumbUrl: r2PublicUrl('thumbs', filename),
  });
}));

// GET /api/v1/products/upload-url-pair?folder=products|defects — presigned PUTs
// for <folder>/<file> AND thumbs/<file> sharing one filename. Lets the client
// resize + make the thumbnail itself and upload both straight to R2 (no image
// bytes through the server). `folder` defaults to products (back-compatible);
// defect-evidence photos pass folder=defects so resolveThumbUrl resolves them.
const ALLOWED_PAIR_FOLDERS = ['products', 'defects'];
router.get('/upload-url-pair', staffOnly, asyncHandler(async (req, res) => {
  const folderRaw = String(req.query.folder || 'products');
  const folder = ALLOWED_PAIR_FOLDERS.includes(folderRaw) ? folderRaw : 'products';
  const filename = `${crypto.randomUUID()}.jpg`;
  const sign = (key) => getSignedUrl(
    s3Client,
    new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key, ContentType: 'image/jpeg', CacheControl: UPLOAD_CACHE_CONTROL }),
    { expiresIn: 300 },
  );
  const [mainUrl, thumbUrl] = await Promise.all([
    sign(`${folder}/${filename}`),
    sign(`thumbs/${filename}`),
  ]);
  res.json({ filename, mainUrl, thumbUrl, cacheControl: UPLOAD_CACHE_CONTROL });
}));

// GET /api/v1/products/upload-url-triple — presigned PUTs for ALL THREE variants
// sharing one filename: originals/<f> (CLEAN, no labels — the embedding/describe
// source), products/<f> (annotated, shown in UI/Telegram), thumbs/<f> (thumbnail
// of the CLEAN original). resolveThumbUrl maps either products/ or originals/ →
// thumbs/, so the shared filename keeps every variant in sync. This is the single
// upload primitive every product-photo flow should use so the clean original is
// guaranteed to exist (we never embed/describe a price/quantity-labelled photo).
router.get('/upload-url-triple', staffOnly, asyncHandler(async (req, res) => {
  const filename = `${crypto.randomUUID()}.jpg`;
  const sign = (key) => getSignedUrl(
    s3Client,
    new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key, ContentType: 'image/jpeg', CacheControl: UPLOAD_CACHE_CONTROL }),
    { expiresIn: 300 },
  );
  const [originalUrl, productUrl, thumbUrl] = await Promise.all([
    sign(`originals/${filename}`),
    sign(`products/${filename}`),
    sign(`thumbs/${filename}`),
  ]);
  res.json({ filename, originalUrl, productUrl, thumbUrl, cacheControl: UPLOAD_CACHE_CONTROL });
}));

// DELETE /api/v1/products/orphan-photo?filename=<uuid>.jpg — best-effort cleanup
// for a partially-failed multi-PUT upload. The triple/pair upload primitives PUT
// 2–3 variants in parallel under one shared filename; if one PUT fails the others
// may already have landed in R2, and since the filename never reaches a DB doc
// they become orphans. The client calls this in its catch with the shared
// filename to wipe every variant (originals/products/thumbs/defects). Idempotent
// and never throws on a missing key — deleting an absent object is a no-op.
router.delete('/orphan-photo', staffOnly, asyncHandler(async (req, res) => {
  const raw = String(req.query.filename || '');
  // basename only, uuid.jpg shape — refuse anything with a path separator so the
  // key can't be steered outside the known variant folders.
  if (!/^[a-f0-9-]+\.(jpg|jpeg|png|webp)$/i.test(raw)) throw appError('product_image_unsupported');
  await deleteR2Objects([
    `originals/${raw}`,
    `products/${raw}`,
    `thumbs/${raw}`,
    `defects/${raw}`,
  ]);
  res.json({ ok: true });
}));

// GET /api/v1/products/upload-url-public?folder=missing-products|price-queries&ext=jpg
// Presigned PUT for EPHEMERAL query photos: the browser uploads straight to R2
// (no bytes through Express), then report-missing / ask-group-price hand the
// object's public URL to Telegram (Telegram fetches it) and delete it. `folder`
// is allow-listed so the returned key can't be steered outside these two scopes.
const ALLOWED_PUBLIC_FOLDERS = ['missing-products', 'price-queries'];
router.get('/upload-url-public', asyncHandler(async (req, res) => {
  const folderRaw = String(req.query.folder || 'missing-products');
  const folder = ALLOWED_PUBLIC_FOLDERS.includes(folderRaw) ? folderRaw : 'missing-products';
  const ext = String(req.query.ext || 'jpg').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const allowed = ['jpg', 'jpeg', 'png', 'webp'];
  if (!allowed.includes(ext)) throw appError('product_image_unsupported');
  const safeExt = ext === 'jpeg' ? 'jpg' : ext;
  const filename = `${crypto.randomUUID()}.${safeExt}`;
  const key = `${folder}/${filename}`;
  const contentType = 'image/jpeg';
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
  res.json({ uploadUrl, filename, key, contentType });
}));

// POST /api/v1/products/ask-group-price  { filename }
// The browser already PUT the (downscaled) photo straight to R2 under
// price-queries/<filename> via upload-url-public. Fire-and-forget: we hand
// Telegram the object's public URL — Telegram fetches it, so no bytes pass
// through Express — forward to every «Група ціна на товар» (telegram.priceGroupIds)
// with the caption «Яка ціна?», then delete it. This is a one-shot query: nothing
// is stored — no SearchProduct, no lingering R2 object, no barcode.
router.post('/ask-group-price', asyncHandler(async (req, res) => {
  const filename = String(req.body?.filename || '');
  if (!/^[a-f0-9-]+\.(jpg|jpeg|png|webp)$/i.test(filename)) throw appError('product_filename_required');

  const { getPriceGroupIds } = require('./admin');
  const priceGroupIds = await getPriceGroupIds();
  if (!priceGroupIds.length) throw appError('telegram_groups_not_configured');

  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) throw appError('telegram_bot_not_initialized');

  const photoUrl = r2PublicUrl('price-queries', filename);
  const caption = 'Яка ціна?';
  const sendResults = await Promise.all(priceGroupIds.map(async (chatId) => {
    try {
      await bot.sendPhoto(Number(chatId), photoUrl, { caption });
      return { chatId, sent: true };
    } catch (err) {
      console.error('Failed to send price request to group', chatId, err.message || err);
      return { chatId, sent: false };
    }
  }));

  // Telegram has fetched the URL by now (sendPhoto resolves after the message is
  // sent), so the staging object has served its purpose — drop it.
  await deleteR2Objects([`price-queries/${filename}`]);

  const sentCount = sendResults.filter((r) => r.sent).length;
  if (sentCount === 0) throw appError('search_resend_failed');
  res.json({ sent: sentCount, total: priceGroupIds.length });
}));

// GET /api/products/drafts — pending (unconfirmed) products
router.get('/drafts', staffOnly, asyncHandler(async (req, res) => {
  const products = await Product.find({ status: 'pending', source: 'receive' })
    .sort('-updatedAt') // restored products have old createdAt; updatedAt reflects actual recency
    .lean();
  res.json(products);
}));

// GET /api/v1/products/:id/position — absolute index of a product in the
// unfiltered seller catalogue (used for deep-links). Matches the GET / filter
// (not archived + in a block + older than NEW_DAYS or unshelved) and sort
// (orderNumber asc, createdAt desc, _id asc) exactly, so the returned
// `position` lines up with the `offset` clients use to page in.
//
// Returns:
//   200 { position, total }     — found in the catalogue
//   404 { error: 'in_new_products' } — product is "new" (<14 days), lives on the New Products tab
//   404 { error: 'not_in_catalog' }  — archived / not in any block / otherwise hidden
//   400 { error: 'invalid_id' }      — malformed id
router.get('/:id/position', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const isV1 = String(req.baseUrl || '').includes('/api/v1') || String(req.originalUrl || '').startsWith('/api/v1');
  if (!isV1) {
    return res.status(404).json({ error: 'v1_only' });
  }
  const target = await Product.findById(id).lean();
  if (!target) return res.status(404).json({ error: 'not_in_catalog' });

  const NEW_DAYS_CUTOFF = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const catalogMatch = {
    status: { $ne: 'archived' },
    $or: [
      { shelvedAt: null },
      { shelvedAt: { $exists: false } },
      { shelvedAt: { $lt: NEW_DAYS_CUTOFF } },
    ],
  };
  const basePipeline = [
    { $match: catalogMatch },
    {
      $lookup: {
        from: 'blocks',
        localField: '_id',
        foreignField: 'productIds',
        as: '_block',
        pipeline: [{ $project: { _id: 1 } }],
      },
    },
    { $match: { '_block.0': { $exists: true } } },
    { $project: { _block: 0 } },
  ];
  const targetObjectId = new mongoose.Types.ObjectId(id);

  // Is the target itself in the catalogue?
  const [selfRes] = await Product.aggregate([
    ...basePipeline,
    { $match: { _id: targetObjectId } },
    { $count: 'count' },
  ]);
  if (!selfRes?.count) {
    const isNew = target.shelvedAt && new Date(target.shelvedAt) >= NEW_DAYS_CUTOFF
      && target.status !== 'archived';
    return res.status(404).json({ error: isNew ? 'in_new_products' : 'not_in_catalog' });
  }

  // Count catalogue products that sort strictly before the target. Mirrors the
  // GET / sort exactly so `position` == `offset` for paging.
  const targetOrderNumber = target.orderNumber ?? 0;
  const beforeMatch = {
    $or: [
      { orderNumber: { $lt: targetOrderNumber } },
      { orderNumber: targetOrderNumber, createdAt: { $gt: target.createdAt } },
      { orderNumber: targetOrderNumber, createdAt: target.createdAt, _id: { $lt: targetObjectId } },
    ],
  };
  const [beforeRes, totalRes] = await Promise.all([
    Product.aggregate([...basePipeline, { $match: beforeMatch }, { $count: 'count' }]),
    Product.aggregate([...basePipeline, { $count: 'count' }]),
  ]);
  res.json({
    position: beforeRes[0]?.count ?? 0,
    total: totalRes[0]?.count ?? 0,
  });
}));

router.get('/', async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 24));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const dateFilter = req.query.date_filter;
  const query = { status: { $ne: 'archived' } };

  if (req.query.barcode) {
    const barcodeValue = String(req.query.barcode).trim();
    if (barcodeValue) {
      query.barcode = barcodeValue;
    }
  }

  if (req.query.search) {
    const rawSearch = String(req.query.search).trim();
    if (rawSearch) {
      const terms = rawSearch.split(/\s+/).map(escapeRegex).filter(Boolean);
      if (terms.length) {
        query.$and = terms.map((term) => ({
          $or: [
            { brand: new RegExp(term, 'i') },
            { model: new RegExp(term, 'i') },
            { category: new RegExp(term, 'i') },
            { warehouse: new RegExp(term, 'i') },
            { barcode: new RegExp(term, 'i') },
            { aiDescription: new RegExp(term, 'i') },
          ],
        }));
      }
    }
  }

  if (dateFilter) {
    const parsedDate = new Date(dateFilter);
    if (!Number.isNaN(parsedDate.getTime())) {
      const nextDay = new Date(parsedDate);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      query.createdAt = { $gte: parsedDate, $lt: nextDay };
    }
  }

  const isV1 = String(req.baseUrl || '').includes('/api/v1') || String(req.originalUrl || '').startsWith('/api/v1');

  // For the seller-facing catalogue (v1), show only products placed in blocks
  // AND older than NEW_DAYS — newer products live on the "Нові товари" page.
  // Products with shelvedAt=null pre-date the Прийомка flow and go straight to the catalogue.
  // Use $lookup aggregation to do the join server-side — avoids loading all productIds into Node.js memory.
  const NEW_DAYS_CUTOFF = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  if (isV1) {
    query.$or = [
      { shelvedAt: null },
      { shelvedAt: { $exists: false } },
      { shelvedAt: { $lt: NEW_DAYS_CUTOFF } },
    ];
    const basePipeline = [
      { $match: query },
      {
        $lookup: {
          from: 'blocks',
          localField: '_id',
          foreignField: 'productIds',
          as: '_block',
          pipeline: [{ $project: { _id: 1 } }],
        },
      },
      { $match: { '_block.0': { $exists: true } } },
    ];

    const [countResult] = await Product.aggregate([...basePipeline, { $count: 'total' }]);
    const total = countResult?.total ?? 0;

    // Vectors now live in the productvectors collection, so a catalogue doc is ~0.8 KB.
    // A plain sort/skip/limit is safe: the old sort-keys→self-$lookup "hydrate dance"
    // existed only to keep the blocking in-memory sort under Mongo's 32 MB limit when
    // every doc still carried the ~36 KB geminiVector (error 292 on deep pages — this
    // cluster has no allowDiskUse). That weight is gone. `_block` is just the join
    // marker from the shelf filter above — drop it. `_id` is the final sort tiebreak so
    // the /:id/position endpoint can compute an offset that matches this list.
    const products = await Product.aggregate([
      ...basePipeline,
      { $project: { _block: 0 } },
      { $sort: { orderNumber: 1, createdAt: -1, _id: 1 } },
      { $skip: offset },
      { $limit: limit },
    ]);

    // Shelf location ({ blockId, position, total }) is opt-in via ?withLocation=1
    // — only the Товари Складу page needs it (card display + "Показати в блоці").
    // The seller catalogue shares this endpoint on its hottest path, so we skip
    // the extra Block lookup there. Every v1 product is on a shelf (the _block.0
    // match above), so when requested the location is always present.
    const wantLocation = req.query.withLocation === '1' || req.query.withLocation === 'true';
    const locMap = wantLocation ? await buildLocationMap(products.map((p) => p._id)) : new Map();

    const items = products.map((product) => ({
      id: product._id,
      title: getProductTitle(product),
      location: wantLocation ? (locMap.get(String(product._id)) || null) : undefined,
      name: product.name || '',
      price: product.price,
      quantity: product.quantity,
      quantityPerPackage: product.quantityPerPackage || 0,
      barcode: product.barcode || '',
      source: product.source || '',
      image_url: product.imageUrls?.[0] || product.localImageUrl || '',
      thumbnail_url: product.imageUrls?.[0] || product.localImageUrl || '',
      // Raw image fields + label positions: the warehouse editor (InlinePhotoCanvas)
      // needs the CLEAN originalImageUrl and the saved labelPositions to reopen with
      // markers in place and avoid baking labels on top of an already-annotated photo.
      // The seller mini-app ignores these extra fields (it reads image_url/thumbnail_url).
      imageUrls: product.imageUrls || [],
      originalImageUrl: product.originalImageUrl || '',
      localImageUrl: product.localImageUrl || '',
      labelPositions: product.labelPositions || {},
      status: product.status,
      orderNumber: product.orderNumber ?? 0,
      createdAt: product.createdAt,
      shelvedAt: product.shelvedAt || null,
    }));

    return res.json({
      items,
      offset,
      limit,
      total,
      hasMore: offset + items.length < total,
    });
  }

  const total = await Product.countDocuments(query);
  const products = await Product.find(query)
    .sort({ orderNumber: 1, createdAt: -1 })
    .skip(offset)
    .limit(limit)
    .lean();

  res.json(products);
});

router.get('/check', asyncHandler(async (req, res) => {
  const barcodeValue = String(req.query.barcode || '').trim();
  const normalizedBarcode = normalizeBarcode(barcodeValue);
  if (!normalizedBarcode) throw appError('product_barcode_required');

  const product = await Product.findOne({ barcode: normalizedBarcode, status: { $ne: 'archived' } }).lean();

  if (!product) {
    return res.json({ found: false });
  }

  const block = await Block.findOne({ productIds: product._id }).lean();

  return res.json({
    found: true,
    product: {
      id: product._id,
      barcode: product.barcode,
      title: getProductTitle(product),
      brand: product.brand,
      model: product.model,
      category: product.category,
      price: product.price,
      quantity: product.quantity,
      image_url: product.imageUrls?.[0] || product.localImageUrl || '',
      status: product.status,
    },
    blockId: block ? block.blockId : null,
  });
}));

router.get('/pending', asyncHandler(async (req, res) => {
  const products = await Product.find({ status: 'pending' }).sort({ orderNumber: 1 });
  res.json(products);
}));

// Count of products shelved within the last `days` (default 14) that are visible
// in the seller catalogue (placed in a block). Drives the "Нові товари" nav badge.
router.get('/new-count', asyncHandler(async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [result] = await Product.aggregate([
    { $match: { status: { $ne: 'archived' }, shelvedAt: { $gte: cutoff } } },
    {
      $lookup: {
        from: 'blocks',
        localField: '_id',
        foreignField: 'productIds',
        as: '_block',
        pipeline: [{ $project: { _id: 1 } }],
      },
    },
    { $match: { '_block.0': { $exists: true } } },
    { $count: 'count' },
  ]);
  res.json({ count: result?.count ?? 0 });
}));

// List of products shelved within the last `days` (default 14) that are visible
// in the seller catalogue (placed in a block). Powers the "Нові товари" page.
router.get('/new-list', asyncHandler(async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const products = await Product.aggregate([
    { $match: { status: { $ne: 'archived' }, shelvedAt: { $gte: cutoff } } },
    {
      $lookup: {
        from: 'blocks',
        localField: '_id',
        foreignField: 'productIds',
        as: '_block',
        pipeline: [{ $project: { _id: 1 } }],
      },
    },
    { $match: { '_block.0': { $exists: true } } },
    { $sort: { shelvedAt: -1 } },
    {
      $project: {
        name: 1,
        brand: 1,
        price: 1,
        quantity: 1,
        shelvedAt: 1,
        imageUrls: 1,
        image_url: 1,
      },
    },
  ]);
  res.json({ products });
}));

router.patch('/reorder', staffOnly, asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) throw appError('product_reorder_invalid');

  const bulkOps = order.map((id, index) => ({
    updateOne: {
      filter: { _id: id },
      update: { orderNumber: index + 1 },
    },
  }));

  // bulkWrite is not atomic by itself — a partial failure would leave the catalog
  // half-reordered. Wrap it in a transaction so the whole batch commits or none.
  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      await Product.bulkWrite(bulkOps, { session });
    });
  } finally {
    session.endSession();
  }
  res.json({ message: 'Order updated' });
}));

/*
router.post('/broadcast', async (req, res) => {
  const { productIds, message } = req.body;
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ error: 'productIds must be a non-empty array' });
  }

  const products = await Product.find({ _id: { $in: productIds } });
  res.json({
    message: 'Broadcast stub executed',
    productCount: products.length,
    broadcastMessage: message || 'No message provided',
  });
});
*/

// POST /api/v1/products/report-missing
// Body JSON: { barcode, filename }. The browser PUT the (downscaled) photo
// straight to R2 (missing-products/<filename>) via upload-url-public. We hand
// Telegram the object's public URL — Telegram fetches it, so no bytes pass
// through Express — forward to the groups, then DELETE the R2 object: the photo
// lives on only as a Telegram file_id (reused for resends), never stored in R2.
router.post('/report-missing', asyncHandler(async (req, res) => {
  const barcodeValue = String(req.body?.barcode || '').trim();
  const filename = String(req.body?.filename || '').replace(/[^a-zA-Z0-9._-]/g, '');

  if (!barcodeValue) throw appError('product_barcode_required');
  if (!filename) throw appError('product_filename_required');

  const { getAllowedGroupIds } = require('./admin');
  const allowedGroupIds = await getAllowedGroupIds();

  if (!allowedGroupIds.length) throw appError('telegram_groups_not_configured');

  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) throw appError('telegram_bot_not_initialized');

  const photoUrl = r2PublicUrl('missing-products', filename);
  const normalizedBarcode = normalizeBarcode(barcodeValue);
  const caption = `Штрихкод: ${normalizedBarcode}\nЯка ціна?`;
  const sendResults = await Promise.all(allowedGroupIds.map(async (chatId) => {
    const groupId = String(chatId);
    const existing = await SearchProduct.findOne({ barcode: normalizedBarcode, groupChatId: groupId, status: 'active' });

    // Already sent this barcode to this group — resend by the Telegram file_id
    // (it survives the R2 deletion; the object was only ever a delivery handle).
    if (existing && existing.requestTelegramPhotoFileId) {
      try {
        const sent = await bot.sendPhoto(chatId, existing.requestTelegramPhotoFileId, {
          caption: existing.requestCaption || caption,
        });
        await SearchProduct.updateOne(
          { _id: existing._id },
          { requestTelegramMessageId: String(sent.message_id) },
        );
        return { chatId, sent: true, reused: true };
      } catch (err) {
        console.error('Failed to resend existing missing product photo to group', chatId, err.message || err);
      }
    }

    try {
      const sent = await bot.sendPhoto(chatId, photoUrl, { caption });
      const sentPhotoFileId = String(sent.photo?.[sent.photo.length - 1]?.file_id || '');
      await SearchProduct.findOneAndUpdate(
        { barcode: normalizedBarcode, groupChatId: groupId, status: 'active' },
        {
          barcode: normalizedBarcode,
          groupChatId: groupId,
          requestTelegramPhotoFileId: sentPhotoFileId,
          requestTelegramMessageId: String(sent.message_id),
          requestCaption: caption,
          status: 'active',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return { chatId, sent: true, reused: false };
    } catch (err) {
      console.error('Failed to send missing product photo to group', chatId, err.message || err);
      return { chatId, sent: false, error: err.message || String(err) };
    }
  }));

  // Telegram has fetched the URL (sendPhoto resolves after the message is sent),
  // so the staging object has served its purpose — drop it.
  await deleteR2Objects([`missing-products/${filename}`]);

  return res.json({ barcode: barcodeValue, caption, sent: sendResults });
}));

async function getActiveDeliveryGroups() {
  let groups = await cache.get(cache.KEYS.DELIVERY_GROUPS);
  if (!groups) {
    groups = await DeliveryGroup.find().lean();
    await cache.set(cache.KEYS.DELIVERY_GROUPS, groups);
  }
  return groups.map(normalizeDeliveryGroup);
}

// GET /api/v1/products/:id/who-ordered — shops with active-session orders for this product
router.get('/:id/who-ordered', staffOnly, asyncHandler(async (req, res) => {
  const allGroups = await getActiveDeliveryGroups();
  const schedule = await getOrderingSchedule();

  const sessionIdResults = await Promise.all(
    allGroups.map((group) => getOrCreateSessionId(String(group._id), group.dayOfWeek, schedule)),
  );
  const currentSessionIds = new Set(sessionIdResults.filter(Boolean));

  if (currentSessionIds.size === 0) {
    return res.json({ shops: [] });
  }

  const orders = await Order.find({
    'items.productId': req.params.id,
    status: { $in: ['new', 'in_progress', 'confirmed'] },
    orderingSessionId: { $in: [...currentSessionIds] },
  }).select('buyerSnapshot').lean();

  const byShop = new Map();
  for (const order of orders) {
    const shopId = String(order.buyerSnapshot?.shopId || '');
    if (!shopId || byShop.has(shopId)) continue;
    byShop.set(shopId, {
      shopName: order.buyerSnapshot?.shopName || '?',
      shopCity: order.buyerSnapshot?.shopCity || '',
    });
  }

  const activeGroupIds = new Set(allGroups.map((group) => String(group._id)));
  const activeShopIds = await Shop.find(
    { deliveryGroupId: { $in: [...activeGroupIds] } },
    '_id'
  ).lean().then((shops) => shops.map((shop) => String(shop._id)));

  const cartKey = `cartState.orderItems.${req.params.id}`;
  const cartUsers = await User.find(
    {
      role: 'seller',
      $and: [
        {
          $or: [
            { deliveryGroupId: { $in: [...activeGroupIds] } },
            { shopId: { $in: activeShopIds } },
          ],
        },
        {
          $or: [
            { [cartKey]: { $gt: 0 } },
            { 'cartState.orderItemIds': req.params.id },
          ],
        },
      ],
    },
    'shopId'
  ).lean();

  const missingShopIds = new Set();
  for (const user of cartUsers) {
    const shopId = String(user.shopId || '');
    if (shopId && !byShop.has(shopId)) missingShopIds.add(shopId);
  }

  if (missingShopIds.size > 0) {
    const shops = await Shop.find({ _id: { $in: [...missingShopIds] } }).populate('cityId', 'name').lean();
    const shopById = new Map(shops.map((shop) => [String(shop._id), shop]));

    for (const user of cartUsers) {
      const shopId = String(user.shopId || '');
      if (!shopId || byShop.has(shopId)) continue;
      const shop = shopById.get(shopId);
      byShop.set(shopId, {
        shopName: shop?.name || '?',
        shopCity: shop?.cityId?.name || '',
      });
    }
  }

  res.json({ shops: [...byShop.values()] });
}));

// Proxy an image through the server so the browser canvas can draw it without
// CORS/taint issues regardless of whether the source is local or R2.
router.get('/proxy-image', asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'invalid_url' });
  }
  const axios = require('axios');
  let upstream;
  try {
    upstream = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  } catch (err) {
    const status = err?.response?.status;
    // A missing R2 object (deleted / never finished uploading) makes axios reject.
    // Surface it as a clean 404 so the client shows a placeholder instead of a
    // scary 500 — and so it's distinguishable from a real proxy/network failure.
    if (status === 404 || status === 403) {
      console.warn('[proxy-image] upstream', status, '(object missing) for', url);
      return res.status(404).json({ error: 'image_not_found' });
    }
    console.error('[proxy-image] upstream fetch failed for', url, '-', err.message);
    return res.status(502).json({ error: 'image_proxy_failed' });
  }
  res.set('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=300');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(Buffer.from(upstream.data));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id).lean();
  if (!product) throw appError('product_not_found');
  // Deep-link pins (?product=) land here — carry the shelf location too so the
  // single pinned card can show block/position and "Показати в блоці".
  const locMap = await buildLocationMap([product._id]);
  product.location = locMap.get(String(product._id)) || null;
  res.json(product);
}));

// POST /api/v1/products/block-upload-photos
// Body: { blockId, filenames: string[] } — filenames already uploaded to R2 by client
router.post('/block-upload-photos', staffOnly, asyncHandler(async (req, res) => {
  const blockId = Number(req.body?.blockId);
  const filenames = Array.isArray(req.body?.filenames) ? req.body.filenames : [];

  if (!blockId || blockId < 1) throw appError('product_block_id_invalid');
  if (!filenames.length) throw appError('product_filenames_required');

  // Pre-flight outside transaction (avoids holding session for a missing block)
  const blockExists = await Block.exists({ blockId });
  if (!blockExists) throw appError('block_not_found');

  const session = await mongoose.connection.startSession();
  let results = [];
  let createdProducts = [];
  let savedBlock;
  try {
    await session.withTransaction(async () => {
      results = []; // reset on retry
      createdProducts = []; // reset on retry
      const block = await Block.findOne({ blockId }).session(session);
      if (!block) throw appError('block_not_found');

      // Read max orderNumber inside the transaction to prevent race conditions
      const maxProduct = await Product.findOne({ status: { $ne: 'archived' } }, 'orderNumber').sort({ orderNumber: -1 }).session(session).lean();
      let nextOrderNumber = (maxProduct?.orderNumber ?? 0) + 1;

      for (const filename of filenames) {
        const safeFilename = String(filename).replace(/[^a-zA-Z0-9._-]/g, '');
        const imageUrl = r2PublicUrl('products', safeFilename);
        const [product] = await Product.create([{
          orderNumber: nextOrderNumber,
          price: 0,
          quantity: 0,
          // block_photo products bypass накладна/Надходження and go STRAIGHT into a
          // block, so they are live immediately → 'active', not 'pending'. 'pending'
          // is reserved for the receive flow (restored/incoming awaiting placement).
          status: 'active',
          source: 'block_photo',
          imageUrls: [imageUrl],
          imageNames: [safeFilename],
          originalImageUrl: imageUrl,
        }], { session });
        block.productIds.push(product._id);
        nextOrderNumber += 1;
        results.push({ productId: String(product._id), imageUrl, index: results.length });
        createdProducts.push(product);
      }

      block.version += 1;
      await block.save({ session });
      savedBlock = block;
    });
  } finally {
    session.endSession();
  }

  // Mirror every uploaded product into the shop catalogue ("Товари Магазинів"),
  // exactly as receipt items mirror on confirm — every product that reaches the
  // warehouse must surface in the shop catalogue. Fire-and-forget AFTER commit
  // (the mirror is a projection, never blocks this request); $setOnInsert means a
  // later label edit's pushSharedFieldsToMirror fills in price/name/photo.
  for (const product of createdProducts) {
    upsertShopProductFromProduct(product).catch((err) =>
      console.error('[products/block-upload] ShopProduct upsert failed:', err.message));
    // Index the shelf photo for the Прийомка warehouse-locate search.
    embedProductAsync(product, 'block-upload');
  }

  try {
    const io = getIO();
    if (io) {
      io.emit('block_updated', {
        blockId: savedBlock.blockId,
        version: savedBlock.version,
        productIds: savedBlock.productIds.map(String),
      });
      // New products added to a block → notify sellers their catalogue changed
      io.emit('catalogue_updated');
    }
  } catch (e) {
    console.warn('[products/upload] socket block_updated failed:', e.message);
  }

  res.json({ uploaded: results.length, total: filenames.length, results });
}));

// POST /api/products/receive — save a product from the web Receive page.
// Required: photo file, quantity.
// Optional: price, quantityPerPackage.
// status is set to 'active' when both price > 0 AND quantityPerPackage > 0, otherwise 'pending'.
// POST /api/v1/products/receive
// Body JSON: { filename, quantity, price?, quantityPerPackage?, notes?, status? }
router.post('/receive', staffOnly, asyncHandler(async (req, res) => {
  const body = req.body;
  const filename = String(body?.filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!filename) throw appError('product_photo_required');
  const originalFilename = body?.originalFilename
    ? String(body.originalFilename).replace(/[^a-zA-Z0-9._-]/g, '')
    : null;

  const quantity = Number(body.quantity ?? 0);
  if (!Number.isInteger(quantity) || quantity < 0) throw appError('product_quantity_invalid');

  const price = body.price !== undefined && body.price !== '' ? Number(body.price) : 0;
  const quantityPerPackage = body.quantityPerPackage !== undefined && body.quantityPerPackage !== '' ? Number(body.quantityPerPackage) : 0;
  const isConfirmed = price > 0 && quantityPerPackage > 0;
  const explicitPending = body.status === 'pending';
  const imageUrl = r2PublicUrl('products', filename);
  const origImageUrl = originalFilename ? r2PublicUrl('originals', originalFilename) : imageUrl;
  const barcode = String(body.barcode || '').trim();

  // Read max orderNumber AND insert the new product inside the same transaction
  // so two concurrent /receive requests cannot read the same max and produce
  // duplicate orderNumbers (race — fixed by the transaction's snapshot read).
  let product;
  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      const maxProduct = await Product.findOne({ status: { $ne: 'archived' } }, 'orderNumber')
        .sort({ orderNumber: -1 })
        .session(session)
        .lean();
      const nextOrderNumber = (maxProduct?.orderNumber ?? 0) + 1;
      const [created] = await Product.create([{
        orderNumber: nextOrderNumber,
        price,
        quantity,
        quantityPerPackage,
        barcode,
        status: explicitPending ? 'pending' : isConfirmed ? 'active' : 'pending',
        source: 'receive',
        notes: body.notes ? String(body.notes) : '',
        originalImageUrl: origImageUrl,
        imageUrls: [imageUrl],
        imageNames: [filename],
      }], { session });
      product = created;
    });
  } finally {
    session.endSession();
  }

  if (product.status === 'active') {
    upsertShopProductFromProduct(product).catch((err) =>
      console.error('[products/receive] ShopProduct upsert failed:', err.message));
  }

  // Index the warehouse photo for the Прийомка "is it already on the warehouse?" search.
  if (product.originalImageUrl || product.imageUrls?.[0]) embedProductAsync(product, 'receive');

  try {
    const io = getIO();
    if (io) io.emit('incoming_updated');
  } catch (e) {
    console.warn('[products/receive] socket incoming_updated failed:', e.message);
  }
  res.status(201).json(product);
}));

// POST /api/v1/products
// Body JSON: { orderNumber, price, quantity, filename?, ...rest }
router.post('/', staffOnly, asyncHandler(async (req, res) => {
  const fields = req.body;
  const { orderNumber, name, category, brand, model, warehouse, status } = fields;
  const price = Number(fields.price ?? 0);
  const quantity = Number(fields.quantity ?? 0);
  const parsedOrderNumber = Number(orderNumber ?? 0);
  const currentBrand = brand || name || '';

  if (price <= 0 || quantity < 0 || parsedOrderNumber <= 0) throw appError('product_required_fields');

  let imageUrls = [];
  let imageNames = [];
  const filenames = Array.isArray(fields.filenames) ? fields.filenames
    : (fields.filename ? [fields.filename] : []);
  for (const fn of filenames) {
    const safe = String(fn).replace(/[^a-zA-Z0-9._-]/g, '');
    if (safe) { imageUrls.push(r2PublicUrl('products', safe)); imageNames.push(safe); }
  }

  // shiftUp() and product.save() must be atomic — a crash between them would
  // leave a hole in orderNumber sequence (everything shifted, but the new
  // product never inserted). Wrap them in one transaction.
  let product;
  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      await shiftUp({ orderNumber: { $gte: parsedOrderNumber } }, session);
      const [created] = await Product.create([{
        orderNumber: parsedOrderNumber,
        price,
        quantity,
        warehouse: warehouse || '',
        category: category || '',
        brand: currentBrand,
        model: model || '',
        status: status || 'pending',
        imageUrls,
        imageNames,
      }], { session });
      product = created;
    });
  } finally {
    session.endSession();
  }

  res.status(201).json(product);
}));

router.patch('/:id', staffOnly, asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw appError('product_not_found');

  const fields = req.body;

  const { orderNumber, name, category, brand, model, warehouse, status, price, quantity } = fields;
  const parsedOrderNumber = orderNumber !== undefined ? Number(orderNumber) : product.orderNumber;
  const incomingBrand = brand || product.brand;

  if (orderNumber !== undefined && (Number.isNaN(parsedOrderNumber) || parsedOrderNumber <= 0)) {
    throw appError('product_order_invalid');
  }

  if (status === 'archived') {
    // Don't allow archiving via PATCH — use DELETE endpoint for proper soft-delete
    throw appError('product_archive_via_delete');
  }

  // Apply mutations to the product object first (in-memory) — they are persisted
  // inside the transaction below so that orderNumber shift and product.save()
  // commit atomically. Without the transaction a crash between the two steps
  // would leave the catalog with duplicate orderNumbers.
  const orderChanged = orderNumber !== undefined && parsedOrderNumber !== product.orderNumber;
  const previousOrderNumber = product.orderNumber;
  const previousStatus = product.status;

  product.orderNumber = parsedOrderNumber;
  if (name !== undefined) product.name = name;
  if (category !== undefined) product.category = category;
  if (incomingBrand !== undefined) product.brand = incomingBrand;
  if (model !== undefined) product.model = model;
  if (warehouse !== undefined) product.warehouse = warehouse;
  if (status !== undefined) {
    product.status = status;
    product.archivedAt = null;
  }
  const previousPrice = Number(product.price || 0);
  if (price !== undefined) {
    const p = Number(price);
    if (Number.isFinite(p)) product.price = p;
  }
  if (quantity !== undefined) {
    const q = Number(quantity);
    if (Number.isFinite(q)) product.quantity = q;
  }
  if (fields.notes !== undefined) product.notes = String(fields.notes);
  if (fields.labelPositions !== undefined) {
    const lp = fields.labelPositions;
    product.labelPositions = typeof lp === 'string' ? JSON.parse(lp) : lp;
  }
  if (fields.quantityPerPackage !== undefined) {
    product.quantityPerPackage = Number(fields.quantityPerPackage);
  }
  if (fields.barcode !== undefined) {
    product.barcode = String(fields.barcode || '').trim();
  }

  const patchFilenames = Array.isArray(fields.filenames) ? fields.filenames
    : (fields.filename ? [fields.filename] : []);
  const oldImageNames = patchFilenames.length > 0 ? [...(product.imageNames || [])] : [];
  if (patchFilenames.length > 0) {
    const imageUrls = [];
    const imageNames = [];
    for (const fn of patchFilenames) {
      const safe = String(fn).replace(/[^a-zA-Z0-9._-]/g, '');
      if (safe) { imageUrls.push(r2PublicUrl('products', safe)); imageNames.push(safe); }
    }
    // Update clean original only when the client explicitly provides one (raw camera
    // capture uploaded to originals/). Never promote a products/ labeled file as the
    // original — that would cause labels to stack on subsequent canvas edits.
    if (fields.originalFilename) {
      const safeOrig = String(fields.originalFilename).replace(/[^a-zA-Z0-9._-]/g, '');
      if (safeOrig) product.originalImageUrl = r2PublicUrl('originals', safeOrig);
    }
    product.imageUrls = imageUrls;
    product.imageNames = imageNames;
    product.telegramFileId = undefined;
    product.telegramMessageIds = [];
  }

  const barcodeChanged = fields.barcode !== undefined;
  const needsSession = orderChanged || barcodeChanged;

  if (needsSession) {
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        if (orderChanged) {
          // status:{$ne:archived} — archived products hold orderNumber:0 and must
          // never be touched by a reorder shift. Matches archiveProduct/archive.js;
          // this PATCH path was the lone shifter missing the filter.
          if (parsedOrderNumber < previousOrderNumber) {
            await shiftUp(
              { _id: { $ne: product._id }, status: { $ne: 'archived' }, orderNumber: { $gte: parsedOrderNumber, $lt: previousOrderNumber } },
              session,
            );
          } else {
            await shiftDown(
              { _id: { $ne: product._id }, status: { $ne: 'archived' }, orderNumber: { $gt: previousOrderNumber, $lte: parsedOrderNumber } },
              session,
            );
          }
        }
        await product.save({ session });
        if (barcodeChanged) {
          await ShopProduct.findOneAndUpdate(
            { linkedProductId: product._id },
            { $set: { barcode: product.barcode } },
            { session },
          );
        }
      });
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.barcode) throw appError('product_barcode_duplicate');
      throw err;
    } finally {
      session.endSession();
    }
  } else {
    try {
      await product.save();
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.barcode) throw appError('product_barcode_duplicate');
      throw err;
    }
  }

  // Keep the linked ShopProduct mirror in sync with the warehouse owner.
  // First activation CREATES the mirror ($setOnInsert with the just-updated
  // values); any later edit PUSHES the shared fields onto the existing mirror.
  // Both are fire-and-forget — the mirror is a projection, not part of this
  // request's contract. Shop-OWNED products (linkedProductId: null) are untouched.
  if (status === 'active' && previousStatus !== 'active') {
    upsertShopProductFromProduct(product).catch((err) =>
      console.error('[products/patch] ShopProduct upsert failed:', err.message));
  } else {
    pushSharedFieldsToMirror(product).catch((err) =>
      console.error('[products/patch] ShopProduct mirror push failed:', err.message));
  }

  // Re-price ACTIVE orders (new/in_progress) that contain this product so the
  // whole order stays in ONE price epoch. Without this, an existing order keeps
  // the old per-item price while a newly merged line gets the new price → the
  // invoice/total mixes price epochs and diverges from the catalogue.
  // confirmed/fulfilled orders are finalized and intentionally NOT touched.
  // Two atomic pipeline updates → no read-modify-write race with set-item-qty.
  if (price !== undefined && Number(price) !== previousPrice) {
    const newPrice = Number(price);
    const activeFilter = {
      status: { $in: ['new', 'in_progress'] },
      'items.productId': product._id,
    };
    await Order.updateMany(
      activeFilter,
      { $set: { 'items.$[elem].price': newPrice } },
      { arrayFilters: [{ 'elem.productId': product._id, 'elem.cancelled': { $ne: true } }] },
    );
    await Order.updateMany(activeFilter, [
      {
        $set: {
          totalPrice: {
            $round: [
              {
                $sum: {
                  $map: {
                    input: {
                      $filter: {
                        input: '$items',
                        as: 'i',
                        cond: { $ne: ['$$i.cancelled', true] },
                      },
                    },
                    as: 'i',
                    in: {
                      $multiply: [
                        { $ifNull: ['$$i.price', 0] },
                        { $ifNull: ['$$i.quantity', 0] },
                      ],
                    },
                  },
                },
              },
              2,
            ],
          },
        },
      },
    ]);
  }

  // Delete replaced R2 images after successful DB save — orphaned objects are
  // acceptable if deletion fails; DB is the source of truth.
  if (oldImageNames.length > 0) {
    const newNameSet = new Set(product.imageNames || []);
    // Never delete the file still referenced as the clean original. block_photo
    // products (Склад-Полки direct upload) store the original + annotated photo
    // under the SAME products/ filename, so without this guard the FIRST label
    // edit would purge the clean original. The edit canvas would then fall back
    // to the already-annotated photo and bake new labels on top of the old ones.
    const originalName = (product.originalImageUrl || '').split('/').pop();
    const toDelete = oldImageNames.filter((n) => !newNameSet.has(n) && n !== originalName);
    if (toDelete.length) {
      deleteR2Objects(toDelete.map((n) => `products/${n}`)).catch(() => {});
    }
  }

  try {
    const io = getIO();
    if (io) {
      io.emit('incoming_updated');
      // A new photo / repositioned labels change what the catalogue tile shows
      // (the seller mini-app reads imageUrls[0]). The catalogue is the one view
      // that stays mounted and only refreshes its window on 'catalogue_updated' —
      // a bare 'incoming_updated' is just for the Надходження lists. Without this
      // the edited photo stays stale on every open catalogue until a full reload.
      if (patchFilenames.length > 0) io.emit('catalogue_updated');
    }
  } catch (e) {
    console.warn('[products/patch] socket incoming_updated failed:', e.message);
  }

  // Photo changed → its warehouse vector is stale; re-index in the background.
  // force:true because the ProductVector row already exists — we must overwrite it
  // (the mirror references this same row, so refreshing it updates the mirror too).
  if (patchFilenames.length > 0 && (product.originalImageUrl || product.imageUrls?.[0])) {
    embedProductAsync(product, 'patch', { force: true });
  }

  res.json(product);
}));

router.delete('/:id', staffOnly, asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw appError('product_not_found');

  const { archiveProduct } = require('../services/archiveProduct');
  await archiveProduct(product, { notifyBuyers: false });

  res.json({ message: 'Product archived' });
}));

// ── POST /:id/describe — generate + cache the human-friendly card description ──
// On-demand (staff presses the button). Plain-language Ukrainian explainer from
// the product photo, cached in aiDescription, then pushed to the linked
// ShopProduct mirror — a mirror is the SAME physical product, so it must show the
// same description. Pressing again regenerates.
router.post('/:id/describe', staffOnly, asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw appError('product_not_found');

  const url = product.originalImageUrl || product.imageUrls?.[0] || '';
  if (!url) return res.status(400).json({ error: 'photo_required', message: 'У товару немає фото' });

  if (!getGeminiStatus().connected && !getOpenAIStatus().connected) {
    return res.status(503).json({ error: 'describe_not_configured', message: 'Опис недоступний: не підключено ні Gemini, ні OpenAI' });
  }

  try {
    const { text, name: aiName } = await describeImageUrl(url);
    if (!text) return res.status(502).json({ error: 'empty_description', message: 'Не вдалося згенерувати опис' });
    product.aiDescription = text;
    // Auto-fill name only when the product has none — never overwrite an existing name.
    if (aiName && !product.name) product.name = aiName;
    await product.save();
    res.json({ _id: product._id, aiDescription: product.aiDescription, aiName: aiName || null });
    // Live-refresh open warehouse boards so the generated name/description shows
    // without a reload (same channel the photo edit uses).
    try { const io = getIO(); if (io) io.emit('incoming_updated'); }
    catch (e) { console.warn('[products/describe] socket emit failed:', e.message); }
    pushSharedFieldsToMirror(product, {}).catch((err) =>
      console.error('[products/describe] ShopProduct mirror push failed:', err.message));
  } catch (err) {
    console.error('[products] describe error:', err.message);
    return res.status(502).json({ error: 'describe_api_error', message: err.message });
  }
}));

module.exports = router;
