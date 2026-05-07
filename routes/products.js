const express = require('express');
const crypto = require('crypto');
const Busboy = require('busboy');
const sharp = require('sharp');
const { S3Client, PutObjectCommand, HeadBucketCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
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

// Compress raster images to JPEG ≤200 KB before storing on R2.
// GIFs are stored as-is to preserve animation.
async function compressImage(buffer, contentType) {
  if (/^image\/gif$/i.test(contentType)) {
    return { buffer, contentType };
  }
  const compressed = await sharp(buffer)
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
  return { buffer: compressed, contentType: 'image/jpeg' };
}

async function uploadToR2(fileBuffer, filename, contentType) {
  const { buffer, contentType: finalContentType } = await compressImage(fileBuffer, contentType);
  const ext = /^image\/gif$/i.test(contentType) ? (filename.split('.').pop() || 'gif') : 'jpg';
  const safeFilename = `${crypto.randomUUID()}.${ext.replace(/[^a-zA-Z0-9]/g, '')}`;
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: `products/${safeFilename}`,
    Body: buffer,
    ContentType: finalContentType,
  }));
  return safeFilename;
}

function getProductTitle(product) {
  return product.brand || product.model || product.category || `#${product.orderNumber}`;
}

const router = express.Router();

router.get('/images/:filename', async (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  try {
    const data = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: `products/${filename}`,
    }));
    res.set('Content-Type', data.ContentType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Access-Control-Allow-Origin', '*');
    data.Body.pipe(res);
  } catch {
    res.status(404).json({ error: 'Image not found' });
  }
});

// GET /api/products/drafts — pending (unconfirmed) products
router.get('/drafts', staffOnly, async (req, res) => {
  try {
    const products = await Product.find({ status: 'pending', source: 'receive' })
      .sort('-createdAt')
      .lean();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

  const isV1 = String(req.baseUrl || '').includes('/api/v1') || String(req.originalUrl || '').startsWith('/api/v1');

  // For the seller-facing catalogue (v1), show only products that are placed in blocks.
  // Products in "incoming" (not yet shelved) should not be orderable.
  if (isV1) {
    const assignedIds = await Block.distinct('productIds');
    query._id = { $in: assignedIds };
  }

  const total = await Product.countDocuments(query);
  const products = await Product.find(query)
    .sort({ orderNumber: 1, createdAt: -1 })
    .skip(offset)
    .limit(limit)
    .lean();
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

// POST /api/products/block-upload-photos
// Each uploaded photo creates a new product (no name/price/category) and appends
// it to the specified block, preserving the exact selection order.
router.post('/block-upload-photos', staffOnly, async (req, res) => {
  const { fields, files } = await parseMultipart(req);
  const blockId = Number(fields.blockId);

  if (!blockId || blockId < 1) {
    return res.status(400).json({ error: 'Invalid blockId' });
  }
  if (!files.length) {
    return res.status(400).json({ error: 'No files provided' });
  }

  const block = await Block.findOne({ blockId });
  if (!block) return res.status(404).json({ error: 'Block not found' });

  // Reserve a contiguous range of orderNumbers by finding the current max
  const maxProduct = await Product.findOne({}, 'orderNumber').sort({ orderNumber: -1 }).lean();
  let nextOrderNumber = (maxProduct?.orderNumber ?? 0) + 1;

  const results = [];

  for (const file of files) {
    const filename = await uploadToR2(file.buffer, file.originalname, file.mimetype);
    const imageUrl = `/api/products/images/${filename}`;

    const product = new Product({
      orderNumber: nextOrderNumber,
      price: 0,
      quantity: 0,
      status: 'pending',
      imageUrls: [imageUrl],
      imageNames: [filename],
    });
    await product.save();

    block.productIds.push(product._id);
    nextOrderNumber += 1;

    results.push({ productId: String(product._id), imageUrl, index: results.length });
  }

  block.version += 1;
  await block.save();

  try {
    const io = getIO();
    if (io) {
      io.emit('block_updated', {
        blockId: block.blockId,
        version: block.version,
        productIds: block.productIds.map(String),
      });
    }
  } catch (_) {}

  res.json({
    uploaded: results.length,
    total: files.length,
    results,
  });
});

// POST /api/products/receive — save a product from the web Receive page.
// Required: photo file, quantity.
// Optional: price, quantityPerPackage.
// status is set to 'active' when both price > 0 AND quantityPerPackage > 0, otherwise 'pending'.
router.post('/receive', staffOnly, async (req, res) => {
  try {
    const { fields, files } = await parseMultipart(req);

    if (!files.length) {
      return res.status(400).json({ error: "Фото є обов'язковим" });
    }

    const quantity = Number(fields.quantity ?? 0);
    if (!Number.isInteger(quantity) || quantity < 0) {
      return res.status(400).json({ error: 'Кількість має бути цілим числом >= 0' });
    }

    const price =
      fields.price !== undefined && fields.price !== ''
        ? Number(fields.price)
        : 0;
    const quantityPerPackage =
      fields.quantityPerPackage !== undefined && fields.quantityPerPackage !== ''
        ? Number(fields.quantityPerPackage)
        : 0;

    const isConfirmed = price > 0 && quantityPerPackage > 0;

    const maxProduct = await Product.findOne({ status: { $ne: 'archived' } })
      .sort({ orderNumber: -1 })
      .lean();
    const nextOrderNumber = (maxProduct?.orderNumber ?? 0) + 1;

    const file = files[0];
    const filename = await uploadToR2(file.buffer, file.originalname, file.mimetype);
    const imageUrl = `/api/products/images/${filename}`;

    const product = new Product({
      orderNumber: nextOrderNumber,
      price,
      quantity,
      quantityPerPackage,
      status: isConfirmed ? 'active' : 'pending',
      source: 'receive',
      notes: fields.notes ? String(fields.notes) : '',
      originalImageUrl: imageUrl,
      imageUrls: [imageUrl],
      imageNames: [filename],
    });
    await product.save();

    res.status(201).json(product);
  } catch (err) {
    console.error('[products/receive] Error:', err);
    res.status(500).json({ error: err.message });
  }
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
  if (fields.notes !== undefined) product.notes = String(fields.notes);
  if (fields.labelPositions !== undefined) {
    try { product.labelPositions = JSON.parse(fields.labelPositions); } catch {}
  }
  if (fields.quantityPerPackage !== undefined) {
    product.quantityPerPackage = Number(fields.quantityPerPackage);
  }
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
