const express = require('express');
const crypto = require('crypto');
const Busboy = require('busboy');
const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { shiftUp, shiftDown } = require('../utils/shiftOrderNumbers');
const { normalizeBarcode } = require('../utils/barcodeScanner');
const Block = require('../models/Block');
const { getIO } = require('../socket');
const Product = require('../models/Product');
const SearchProduct = require('../models/SearchProduct');
const { requireTelegramRoles } = require('../middleware/telegramAuth');

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

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } });
    const fields = {};
    const files = [];

    busboy.on('field', (name, val) => { fields[name] = val; });
    busboy.on('file', (name, stream, info) => {
      const allowed = /^image\/(jpeg|png|webp|gif)$/i;
      if (!allowed.test(info.mimeType)) { stream.resume(); return; }
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        if (stream.truncated) {
          return reject(new Error('File size limit exceeded'));
        }

        files.push({ buffer: Buffer.concat(chunks), originalname: info.filename, mimetype: info.mimeType });
      });
    });

    busboy.on('close', () => resolve({ fields, files }));
    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

async function uploadToR2(fileBuffer, filename, contentType) {
  const extension = filename.split('.').pop() || 'jpg';
  const safeBase = crypto.randomUUID();
  const safeFilename = `${safeBase}.${extension.replace(/[^a-zA-Z0-9]/g, '')}`;
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: `products/${safeFilename}`,
    Body: fileBuffer,
    ContentType: contentType,
  }));
  return safeFilename;
}

function getProductTitle(product) {
  return product.brand || product.model || product.category || `#${product.orderNumber}`;
}

const router = express.Router();

router.get('/images/:filename', (req, res) => {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) return res.status(503).json({ error: 'R2_PUBLIC_URL not configured' });
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  res.redirect(302, `${publicUrl}/products/${filename}`);
});

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

  const total = await Product.countDocuments(query);
  const products = await Product.find(query)
    .sort({ orderNumber: 1, createdAt: -1 })
    .skip(offset)
    .limit(limit)
    .lean();

  const isV1 = String(req.baseUrl || '').includes('/api/v1') || String(req.originalUrl || '').startsWith('/api/v1');
  if (isV1) {
    const items = products.map((product) => ({
      id: product._id,
      title: getProductTitle(product),
      price: product.price,
      quantity: product.quantity,
      image_url: product.imageUrls?.[0] || product.localImageUrl || '',
      thumbnail_url: product.imageUrls?.[0] || product.localImageUrl || '',
      status: product.status,
      createdAt: product.createdAt,
    }));

    return res.json({
      items,
      offset,
      limit,
      total,
      hasMore: offset + items.length < total,
    });
  }

  res.json(products);
});

router.get('/check', async (req, res) => {
  const barcodeValue = String(req.query.barcode || '').trim();
  const normalizedBarcode = normalizeBarcode(barcodeValue);
  if (!normalizedBarcode) {
    return res.status(400).json({ error: 'barcode query parameter is required' });
  }

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
});

router.get('/pending', async (req, res) => {
  const products = await Product.find({ status: 'pending' }).sort({ orderNumber: 1 });
  res.json(products);
});

router.patch('/reorder', staffOnly, async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'Order must be an array of product ids' });
  }

  const bulkOps = order.map((id, index) => ({
    updateOne: {
      filter: { _id: id },
      update: { orderNumber: index + 1 },
    },
  }));

  await Product.bulkWrite(bulkOps);
  res.json({ message: 'Order updated' });
});

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

router.post('/report-missing', async (req, res) => {
  const parsed = await parseMultipart(req);
  const barcodeValue = String(parsed.fields.barcode || '').trim();

  if (!barcodeValue) {
    return res.status(400).json({ error: 'barcode field is required' });
  }

  if (!parsed.files.length) {
    return res.status(400).json({ error: 'photo file is required' });
  }

  const file = parsed.files[0];
  const allowedGroupIds = (process.env.TELEGRAM_ALLOWED_GROUP_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => Number(id));

  if (!allowedGroupIds.length) {
    return res.status(500).json({ error: 'No allowed Telegram groups configured' });
  }

  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) {
    return res.status(500).json({ error: 'Telegram bot is not initialized' });
  }

  const normalizedBarcode = normalizeBarcode(barcodeValue);
  const caption = `Штрихкод: ${normalizedBarcode}\nЯка ціна?`;
  const sendResults = await Promise.all(allowedGroupIds.map(async (chatId) => {
    const groupId = String(chatId);
    const existing = await SearchProduct.findOne({ barcode: normalizedBarcode, groupChatId: groupId, status: 'active' });
    if (existing && existing.requestTelegramPhotoFileId) {
      try {
        await bot.sendPhoto(chatId, existing.requestTelegramPhotoFileId, {
          caption: existing.requestCaption || caption,
        });
        return { chatId, sent: true, reused: true };
      } catch (err) {
        console.error('Failed to resend existing missing product photo to group', chatId, err.message || err);
      }
    }

    try {
      const sent = await bot.sendPhoto(chatId, file.buffer, {
        caption,
        filename: file.originalname || 'photo.jpg',
      });
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

  return res.json({
    barcode: barcodeValue,
    caption,
    sent: sendResults,
  });
});

router.get('/:id', async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

router.post('/', staffOnly, async (req, res) => {
  let fields, files = [];

  if (req.is('multipart/form-data')) {
    const parsed = await parseMultipart(req);
    fields = parsed.fields;
    files = parsed.files;
  } else {
    fields = req.body;
  }

  const { orderNumber, name, category, brand, model, warehouse, status } = fields;
  const price = Number(fields.price ?? 0);
  const quantity = Number(fields.quantity ?? 0);
  const parsedOrderNumber = Number(orderNumber ?? 0);
  const currentBrand = brand || name || '';

  if (price <= 0 || quantity < 0 || parsedOrderNumber <= 0) {
    return res.status(400).json({ error: "Порядковий номер, ціна та кількість є обов'язковими" });
  }

  await shiftUp({ orderNumber: { $gte: parsedOrderNumber } });

  let imageUrls = [];
  let imageNames = [];
  for (const file of files) {
    const filename = await uploadToR2(file.buffer, file.originalname, file.mimetype);
    imageUrls.push(`/api/products/images/${filename}`);
    imageNames.push(filename);
  }

  const product = new Product({
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
  });

  await product.save();
  res.status(201).json(product);
});

router.patch('/:id', staffOnly, async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  let fields = req.body;
  let files = [];

  if (req.is('multipart/form-data')) {
    const parsed = await parseMultipart(req);
    fields = parsed.fields;
    files = parsed.files;
  }

  const { orderNumber, name, category, brand, model, warehouse, status, price, quantity } = fields;
  const parsedOrderNumber = orderNumber !== undefined ? Number(orderNumber) : product.orderNumber;
  const incomingBrand = brand || name;

  if (orderNumber !== undefined && (Number.isNaN(parsedOrderNumber) || parsedOrderNumber <= 0)) {
    return res.status(400).json({ error: 'Порядковий номер має бути цілим числом більше за 0' });
  }

  if (orderNumber !== undefined && parsedOrderNumber !== product.orderNumber) {
    if (parsedOrderNumber < product.orderNumber) {
      await shiftUp({ _id: { $ne: product._id }, orderNumber: { $gte: parsedOrderNumber, $lt: product.orderNumber } });
    } else {
      await shiftDown({ _id: { $ne: product._id }, orderNumber: { $gt: product.orderNumber, $lte: parsedOrderNumber } });
    }
  }

  product.orderNumber = parsedOrderNumber;
  if (category !== undefined) product.category = category;
  if (incomingBrand !== undefined) product.brand = incomingBrand;
  if (model !== undefined) product.model = model;
  if (warehouse !== undefined) product.warehouse = warehouse;
  if (status !== undefined) {
    if (status === 'archived') {
      // Don't allow archiving via PATCH — use DELETE endpoint for proper soft-delete
      return res.status(400).json({ error: 'Використовуйте DELETE для архівації товару' });
    }
    product.status = status;
    product.archivedAt = null;
  }
  if (price !== undefined) product.price = Number(price);
  if (quantity !== undefined) product.quantity = Number(quantity);
  if (fields.barcode !== undefined) {
    product.barcode = String(fields.barcode || '').trim();
  }

  if (files.length > 0) {
    const imageUrls = [];
    const imageNames = [];
    for (const file of files) {
      const filename = await uploadToR2(file.buffer, file.originalname, file.mimetype);
      imageUrls.push(`/api/products/images/${filename}`);
      imageNames.push(filename);
    }
    product.imageUrls = imageUrls;
    product.imageNames = imageNames;
    product.telegramFileId = undefined;
    product.telegramMessageIds = [];
  }

  await product.save();
  res.json(product);
});

router.delete('/:id', staffOnly, async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { archiveProduct } = require('../services/archiveProduct');
  await archiveProduct(product, { notifyBuyers: false });

  res.json({ message: 'Product archived' });
});

module.exports = router;
