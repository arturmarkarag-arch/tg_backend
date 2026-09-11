const express = require('express');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { normalizeBarcode } = require('../utils/barcodeScanner');
const SearchProduct = require('../models/SearchProduct');
const { appError, asyncHandler } = require('../utils/errors');
const { requireTelegramRoles } = require('../middleware/telegramAuth');

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
  } catch (err) {
  }
})();

const router = express.Router();

// SearchProduct is seller/admin/warehouse business data, not a public barcode
// directory. Keep the boundary inside the router as defense-in-depth even if
// app-level public-path configuration changes later.
router.use(requireTelegramRoles(['seller', 'admin', 'warehouse']));

// Rate limiter: max 3 resend requests per barcode per 3 hours
const RESEND_LIMIT = 3;
const RESEND_WINDOW_MS = 3 * 60 * 60 * 1000;
const resendRateLimitMap = new Map(); // barcode -> [timestamp, ...]

function checkResendRateLimit(barcode) {
  const now = Date.now();
  const cutoff = now - RESEND_WINDOW_MS;
  const timestamps = (resendRateLimitMap.get(barcode) || []).filter((t) => t > cutoff);
  if (timestamps.length >= RESEND_LIMIT) {
    return false;
  }
  timestamps.push(now);
  resendRateLimitMap.set(barcode, timestamps);
  return true;
}

// WARNING: Routes under /api/search-products operate on a separate store-only schema.
// This is NOT the same data as /api/products and should remain isolated.
router.get('/images/:filename', asyncHandler(async (req, res) => {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) throw appError('search_r2_public_url_missing');
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  res.redirect(302, `${publicUrl}/search-products/${filename}`);
}));

router.get('/check', asyncHandler(async (req, res) => {
  const barcodeValue = String(req.query.barcode || '').trim();
  const normalizedBarcode = normalizeBarcode(barcodeValue);
  if (!normalizedBarcode) throw appError('product_barcode_required');

  const record = await SearchProduct.findOne({ barcode: normalizedBarcode, status: 'active' }).sort({ updatedAt: -1 }).lean();
  if (!record || !record.price || record.price <= 0) {
    return res.json({
      found: false,
      existingRequest: Boolean(record?.requestTelegramPhotoFileId),
    });
  }

  return res.json({
    found: true,
    searchProduct: {
      id: record._id,
      barcode: record.barcode,
      price: record.price,
      title: record.title,
      caption: record.caption,
      imageUrl: record.imageUrl,
      createdAt: record.createdAt,
    },
  });
}));

router.get('/', asyncHandler(async (req, res) => {
  // Authenticated barcode lookup. Return a narrow DTO, never the raw document.
  const barcodeValue = String(req.query.barcode || '').trim();
  const normalizedBarcode = normalizeBarcode(barcodeValue);
  if (!normalizedBarcode) throw appError('product_barcode_required');

  const rows = await SearchProduct.find({ status: 'active', barcode: normalizedBarcode })
    .select('_id barcode price title caption imageUrl createdAt updatedAt')
    .sort({ createdAt: -1 })
    .lean();
  const items = rows.map((record) => ({
    id: record._id,
    barcode: record.barcode || '',
    price: Number(record.price || 0),
    title: record.title || '',
    caption: record.caption || '',
    imageUrl: record.imageUrl || '',
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
  }));
  res.json({ items });
}));

router.post('/resend', asyncHandler(async (req, res) => {
  const barcodeValue = String(req.body.barcode || '').trim();
  if (!barcodeValue) throw appError('product_barcode_required');

  const normalizedBarcode = normalizeBarcode(barcodeValue);
  if (!normalizedBarcode) throw appError('product_barcode_required');

  if (!checkResendRateLimit(normalizedBarcode)) throw appError('search_resend_rate_limited');

  const record = await SearchProduct.findOne({ barcode: normalizedBarcode, status: 'active' }).sort({ updatedAt: -1 }).lean();
  if (!record || !record.requestTelegramPhotoFileId || !record.groupChatId) throw appError('search_no_existing_request');

  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) throw appError('telegram_bot_not_initialized');

  try {
    await bot.sendPhoto(Number(record.groupChatId), record.requestTelegramPhotoFileId, {
      caption: record.requestCaption || `Штрихкод: ${normalizedBarcode}\nЯка ціна?`,
    });
    return res.json({ resent: true });
  } catch (err) {
    throw appError('search_resend_failed');
  }
}));

module.exports = router;
