const express = require('express');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { normalizeBarcode } = require('../utils/barcodeScanner');
const SearchProduct = require('../models/SearchProduct');

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

const router = express.Router();

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
router.get('/images/:filename', (req, res) => {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) return res.status(503).json({ error: 'R2_PUBLIC_URL not configured' });
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  res.redirect(302, `${publicUrl}/search-products/${filename}`);
});

router.get('/check', async (req, res) => {
  const barcodeValue = String(req.query.barcode || '').trim();
  const normalizedBarcode = normalizeBarcode(barcodeValue);
  if (!normalizedBarcode) {
    return res.status(400).json({ error: 'barcode query parameter is required' });
  }

  const record = await SearchProduct.findOne({ barcode: normalizedBarcode, status: 'active' }).sort({ updatedAt: -1 }).lean();
  if (!record || !record.price || record.price <= 0) {
    return res.json({
      found: false,
      existingRequest: Boolean(record?.requestTelegramPhotoFileId),
      requestCaption: record?.requestCaption || '',
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
      groupChatId: record.groupChatId,
      adminTelegramId: record.adminTelegramId,
      adminName: record.adminName,
      createdAt: record.createdAt,
    },
  });
});

router.get('/', async (req, res) => {
  const barcodeValue = String(req.query.barcode || '').trim();
  const query = { status: 'active' };
  if (barcodeValue) {
    const normalizedBarcode = normalizeBarcode(barcodeValue);
    if (normalizedBarcode) {
      query.barcode = normalizedBarcode;
    }
  }
  const items = await SearchProduct.find(query).sort({ createdAt: -1 }).lean();
  res.json({ items });
});

router.post('/resend', async (req, res) => {
  const barcodeValue = String(req.body.barcode || '').trim();
  if (!barcodeValue) {
    return res.status(400).json({ error: 'barcode field is required' });
  }

  const normalizedBarcode = normalizeBarcode(barcodeValue);
  if (!normalizedBarcode) {
    return res.status(400).json({ error: 'barcode field is required' });
  }

  if (!checkResendRateLimit(normalizedBarcode)) {
    return res.status(429).json({ error: 'Too many resend requests for this barcode. Try again later.' });
  }

  const record = await SearchProduct.findOne({ barcode: normalizedBarcode, status: 'active' }).sort({ updatedAt: -1 }).lean();
  if (!record || !record.requestTelegramPhotoFileId || !record.groupChatId) {
    return res.status(404).json({ error: 'No existing request found for this barcode' });
  }

  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) {
    return res.status(500).json({ error: 'Telegram bot is not initialized' });
  }

  try {
    await bot.sendPhoto(Number(record.groupChatId), record.requestTelegramPhotoFileId, {
      caption: record.requestCaption || `Штрихкод: ${normalizedBarcode}\nЯка ціна?`,
    });
    return res.json({ resent: true });
  } catch (err) {
    console.error('Failed to resend existing request:', err.message || err);
    return res.status(500).json({ error: 'Failed to resend request' });
  }
});

module.exports = router;
