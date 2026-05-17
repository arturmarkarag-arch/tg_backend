const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { buildImageVariants } = require('../utils/imageService');
const { shiftUp, shiftDown } = require('../utils/shiftOrderNumbers');
const { normalizeBarcode } = require('../utils/barcodeScanner');
const Block = require('../models/Block');
const { getIO } = require('../socket');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const Shop = require('../models/Shop');
const DeliveryGroup = require('../models/DeliveryGroup');
const SearchProduct = require('../models/SearchProduct');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');
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

function r2PublicUrl(folder, filename) {
  const base = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
  return `${base}/${folder}/${filename}`;
}

async function r2Put(key, body, contentType = 'image/jpeg') {
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
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
  return product.brand || product.model || product.category || `#${product.orderNumber}`;
}

const router = express.Router();

// GET /api/v1/products/upload-url-public?ext=jpg — public presigned PUT URL for missing-product reports (no auth required)
router.get('/upload-url-public', asyncHandler(async (req, res) => {
  const ext = String(req.query.ext || 'jpg').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const allowed = ['jpg', 'jpeg', 'png', 'webp'];
  if (!allowed.includes(ext)) throw appError('product_image_unsupported');
  const safeExt = ext === 'jpeg' ? 'jpg' : ext;
  const filename = `${crypto.randomUUID()}.${safeExt}`;
  const key = `missing-products/${filename}`;
  const contentType = 'image/jpeg';
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
  res.json({ uploadUrl, filename, key, contentType });
}));

// POST /api/v1/products/upload-image?folder=products — raw image bytes in body.
// The server resizes via sharp into a main (1200px) + thumb (240px) JPEG pair,
// stores both in R2 (<folder>/<name>.jpg and thumbs/<name>.jpg) and returns the
// shared filename. This is the single image-processing entry point.
router.post(
  '/upload-image',
  staffOnly,
  express.raw({ type: () => true, limit: '30mb' }),
  asyncHandler(async (req, res) => {
    const folder = String(req.query.folder || 'products');
    const safeFolder = ALLOWED_UPLOAD_FOLDERS.includes(folder) ? folder : 'products';
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw appError('product_photo_required');
    }

    const { filename, main, thumb } = await buildImageVariants(req.body);
    await Promise.all([
      r2Put(`${safeFolder}/${filename}`, main),
      r2Put(`thumbs/${filename}`, thumb),
    ]);

    res.json({
      filename,
      url: r2PublicUrl(safeFolder, filename),
      thumbUrl: r2PublicUrl('thumbs', filename),
    });
  }),
);


// GET /api/products/drafts — pending (unconfirmed) products
router.get('/drafts', staffOnly, asyncHandler(async (req, res) => {
  const products = await Product.find({ status: 'pending', source: 'receive' })
    .sort('-createdAt')
    .lean();
  res.json(products);
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

  // For the seller-facing catalogue (v1), show only products placed in blocks.
  // Use $lookup aggregation to do the join server-side — avoids loading all productIds into Node.js memory.
  if (isV1) {
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
      { $project: { _block: 0 } },
    ];

    const [countResult] = await Product.aggregate([...basePipeline, { $count: 'total' }]);
    const total = countResult?.total ?? 0;

    const products = await Product.aggregate([
      ...basePipeline,
      { $sort: { orderNumber: 1, createdAt: -1 } },
      { $skip: offset },
      { $limit: limit },
    ]);

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
// Body JSON: { barcode, filename } — client uploads photo to R2 via upload-url-public first, then sends filename
// Server fetches buffer from missing-products/ folder in R2 and forwards to Telegram groups
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

  // Fetch photo buffer from R2
  const r2Object = await s3Client.send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: `missing-products/${filename}`,
  }));
  const chunks = [];
  for await (const chunk of r2Object.Body) chunks.push(chunk);
  const photoBuffer = Buffer.concat(chunks);

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
      const sent = await bot.sendPhoto(chatId, photoBuffer, {
        caption,
        filename: `${normalizedBarcode}.jpg`,
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

router.get('/:id', asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw appError('product_not_found');
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
  let savedBlock;
  try {
    await session.withTransaction(async () => {
      results = []; // reset on retry
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
          status: 'pending',
          source: 'block_photo',
          imageUrls: [imageUrl],
          imageNames: [safeFilename],
          originalImageUrl: imageUrl,
        }], { session });
        block.productIds.push(product._id);
        nextOrderNumber += 1;
        results.push({ productId: String(product._id), imageUrl, index: results.length });
      }

      block.version += 1;
      await block.save({ session });
      savedBlock = block;
    });
  } finally {
    session.endSession();
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
  const incomingBrand = brand || name;

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

  product.orderNumber = parsedOrderNumber;
  if (category !== undefined) product.category = category;
  if (incomingBrand !== undefined) product.brand = incomingBrand;
  if (model !== undefined) product.model = model;
  if (warehouse !== undefined) product.warehouse = warehouse;
  if (status !== undefined) {
    product.status = status;
    product.archivedAt = null;
  }
  if (price !== undefined) product.price = Number(price);
  if (quantity !== undefined) product.quantity = Number(quantity);
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
    // Preserve originalImageUrl — it always points to the clean, un-annotated photo.
    // On first edit the current imageUrls[0] becomes the original; on subsequent edits keep it.
    if (!product.originalImageUrl && product.imageUrls?.[0]) {
      product.originalImageUrl = product.imageUrls[0];
    }
    product.imageUrls = imageUrls;
    product.imageNames = imageNames;
    product.telegramFileId = undefined;
    product.telegramMessageIds = [];
  }

  if (orderChanged) {
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        if (parsedOrderNumber < previousOrderNumber) {
          await shiftUp(
            { _id: { $ne: product._id }, orderNumber: { $gte: parsedOrderNumber, $lt: previousOrderNumber } },
            session,
          );
        } else {
          await shiftDown(
            { _id: { $ne: product._id }, orderNumber: { $gt: previousOrderNumber, $lte: parsedOrderNumber } },
            session,
          );
        }
        await product.save({ session });
      });
    } finally {
      session.endSession();
    }
  } else {
    await product.save();
  }

  // Delete replaced R2 images after successful DB save — orphaned objects are
  // acceptable if deletion fails; DB is the source of truth.
  if (oldImageNames.length > 0) {
    const newNameSet = new Set(product.imageNames || []);
    const toDelete = oldImageNames.filter((n) => !newNameSet.has(n));
    if (toDelete.length) {
      deleteR2Objects(toDelete.map((n) => `products/${n}`)).catch(() => {});
    }
  }

  try {
    const io = getIO();
    if (io) io.emit('incoming_updated');
  } catch (e) {
    console.warn('[products/patch] socket incoming_updated failed:', e.message);
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

module.exports = router;
