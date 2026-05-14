const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Busboy = require('busboy');
const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const Receipt = require('../models/Receipt');
const ReceiptItem = require('../models/ReceiptItem');
const Product = require('../models/Product');
const User = require('../models/User');
const Order = require('../models/Order');
const Block = require('../models/Block');
const ReceiptItemLog = require('../models/ReceiptItemLog');
const DeliveryGroup = require('../models/DeliveryGroup');
const Shop = require('../models/Shop');
const { getIO } = require('../socket');
const { appError, asyncHandler } = require('../utils/errors');

const staffOnly = requireTelegramRoles(['admin', 'warehouse']);

const FIELD_LABELS = {
  name: 'Назва',
  totalQty: 'Загальна к-сть',
  transitQty: 'В магазини',
  shelfQty: 'На склад',
  price: 'Ціна',
  qtyPerPackage: 'В упаковці',
  qtyPerShop: 'На магазин',
  barcode: 'Штрихкод',
  photoUrl: 'Фото',
};

function getActor(req) {
  const u = req.telegramUser || {};
  return {
    telegramId: String(u.telegramId || ''),
    firstName: u.firstName || '',
    lastName: u.lastName || '',
  };
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
      if (!allowed.test(info.mimeType)) {
        stream.resume();
        return;
      }

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
  const extension = String(filename).split('.').pop() || 'jpg';
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

/** Parses a form-field string to a safe non-negative integer. Returns fallback on NaN/negative/missing. */
function parseIntField(val, fallback = 0) {
  const n = Math.trunc(Number(val));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Parses a JSON array field. Returns [] when absent, string[] on success, null on bad JSON. */
function safeParseArray(val) {
  if (!val) return [];
  try {
    const arr = JSON.parse(val);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : null;
  } catch {
    return null;
  }
}

const router = express.Router();

router.get('/', staffOnly, asyncHandler(async (req, res) => {
  const statusFilter = req.query.status;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));

  const query = {};
  if (statusFilter) query.status = statusFilter;

  const [total, receipts] = await Promise.all([
    Receipt.countDocuments(query),
    Receipt.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
  ]);

  // Batch count items (one aggregate instead of N queries)
  const receiptIds = receipts.map((r) => r._id);
  const counts = await ReceiptItem.aggregate([
    { $match: { receiptId: { $in: receiptIds } } },
    { $group: { _id: '$receiptId', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
  const receiptsWithCounts = receipts.map((r) => ({ ...r, itemsCount: countMap.get(String(r._id)) || 0 }));

  res.json({
    receipts: receiptsWithCounts,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  });
}));

router.get('/:id', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id).lean();
  if (!receipt) throw appError('receipt_not_found');
  res.json(receipt);
}));

router.delete('/:id', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id);
  if (!receipt) throw appError('receipt_not_found');
  if (receipt.status !== 'draft') throw appError('receipt_only_draft_delete');

  const itemCount = await ReceiptItem.countDocuments({ receiptId: receipt._id });
  if (itemCount > 0) throw appError('receipt_only_empty_delete');

  await receipt.deleteOne();
  res.json({ message: 'Receipt deleted' });
}));

router.post('/', staffOnly, asyncHandler(async (req, res) => {
  const receiptNumber = `REC-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const receipt = new Receipt({
    receiptNumber,
    status: 'draft',
    createdBy: req.user.telegramId,
  });
  try {
    await receipt.save();
  } catch (err) {
    if (err.code === 11000) throw appError('receipt_number_exists');
    throw err;
  }
  ReceiptItemLog.create({
    receiptId: receipt._id,
    itemName: receipt.receiptNumber,
    action: 'receipt_create',
    actor: getActor(req),
  }).catch((e) => console.error('[ReceiptItemLog] receipt_create error:', e));
  res.status(201).json(receipt);
}));

router.post('/:id/items', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id);
  if (!receipt) throw appError('receipt_not_found');
  if (receipt.status !== 'draft') throw appError('receipt_already_completed');

  if (!req.is('multipart/form-data')) throw appError('receipt_multipart_required');

  const parsed = await parseMultipart(req);
  const file = parsed.files?.[0];
  const existingProductId = parsed.fields.existingProductId ? String(parsed.fields.existingProductId).trim() : null;
  const isWarehousePending = parsed.fields.warehousePending === 'true';
  const deliveryGroupIds = safeParseArray(parsed.fields.deliveryGroupIds);
  if (deliveryGroupIds === null) throw appError('receipt_invalid_delivery_groups');
  if (deliveryGroupIds.length > 0) {
    const existingCount = await DeliveryGroup.countDocuments({ _id: { $in: deliveryGroupIds } });
    if (existingCount !== deliveryGroupIds.length) throw appError('receipt_delivery_groups_missing');
  }
  const qtyPerShop = parseIntField(parsed.fields.qtyPerShop);

  if (!file && !existingProductId) throw appError('receipt_photo_required');

  const totalQty = parseIntField(parsed.fields.totalQty);
  const transitQty = parseIntField(parsed.fields.transitQty);
  const shelfQty = totalQty - transitQty;

  if (totalQty < 1) throw appError('receipt_qty_invalid');
  if (shelfQty < 0) throw appError('receipt_transit_exceeds_total');

  let photoUrl;
  let photoName;
  if (file) {
    const filename = await uploadToR2(file.buffer, file.originalname, file.mimetype);
    photoUrl = `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/products/${filename}`;
    photoName = file.originalname || filename;
  }

  // Pull photo from existingProduct if item has no photo
  if (!photoUrl && existingProductId) {
    const existingProduct = await Product.findById(existingProductId).lean();
    if (existingProduct) {
      photoUrl = existingProduct.imageUrls?.[0] || existingProduct.localImageUrl || '';
      photoName = existingProduct.imageNames?.[0] || existingProduct.imageUrls?.[0] || 'photo.jpg';
    }
  }

  const receiptItem = new ReceiptItem({
    receiptId: receipt._id,
    photoUrl: photoUrl || '',
    photoName: photoName || '',
    totalQty,
    transitQty: transitQty || 0,
    deliveryGroupIds: Array.isArray(deliveryGroupIds) ? deliveryGroupIds : [],
    qtyPerShop,
    shelfQty,
    name: String(parsed.fields.name || '').trim(),
    price: parsed.fields.price !== undefined && parsed.fields.price !== '' ? Number(parsed.fields.price) : null,
    qtyPerPackage: parsed.fields.qtyPerPackage ? Number(parsed.fields.qtyPerPackage) : 1,
    barcode: String(parsed.fields.barcode || '').trim(),
    existingProductId: existingProductId || null,
    warehousePending: isWarehousePending,
  });

  await receiptItem.save();

  // Log: who added this item
  ReceiptItemLog.create({
    receiptId: receipt._id,
    itemId: receiptItem._id,
    itemName: receiptItem.name,
    action: 'create',
    actor: getActor(req),
  }).catch((e) => console.error('[ReceiptItemLog] create error:', e));

  const io = getIO();
  if (io) {
    io.to(`receipt_${receipt._id.toString()}`).emit('receipt_item_added', receiptItem);
  }

  res.status(201).json(receiptItem);
}));

router.get('/:id/items', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id);
  if (!receipt) throw appError('receipt_not_found');

  const items = await ReceiptItem.find({ receiptId: receipt._id }).sort({ createdAt: -1 }).lean();

  // Enrich each item with currentLocation (block + product status) and productCurrentQty
  const productIds = items.map((i) => i.existingProductId || i.createdProductId).filter(Boolean);
  let productMap = {};
  let blockMap = {};

  if (productIds.length > 0) {
    const [products, blocks] = await Promise.all([
      Product.find({ _id: { $in: productIds } }, 'quantity status barcodeChecked barcode').lean(),
      Block.find({ productIds: { $in: productIds } }, 'blockId productIds').lean(),
    ]);
    productMap = Object.fromEntries(products.map((p) => [String(p._id), p]));
    for (const block of blocks) {
      for (const pid of block.productIds) {
        blockMap[String(pid)] = block.blockId;
      }
    }
  }

  const enrichedItems = items.map((item) => {
    const productId = item.existingProductId || item.createdProductId;
    const product = productId ? productMap[String(productId)] : null;
    const blockId = productId ? (blockMap[String(productId)] ?? null) : null;
    return {
      ...item,
      currentLocation: { blockId, status: product?.status ?? null },
      productCurrentQty: product?.quantity ?? null,
      barcodeChecked: product?.barcodeChecked ?? false,
    };
  });

  res.json(enrichedItems);
}));

// ОНОВЛЕННЯ ПОЗИЦІЇ (PATCH)
router.patch('/:id/items/:itemId', staffOnly, asyncHandler(async (req, res) => {
  if (!req.is('multipart/form-data')) {
    throw appError('validation_failed', { field: 'multipart/form-data is required' });
  }

  // Validate receipt status and item existence BEFORE consuming the body
  const [receipt, item] = await Promise.all([
    Receipt.findById(req.params.id).lean(),
    ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id }),
  ]);
  if (!item) throw appError('receipt_item_not_found');
  if (!receipt || receipt.status !== 'draft') throw appError('receipt_completed_locked');

  const parsed = await parseMultipart(req);

  const totalQty = parsed.fields.totalQty !== undefined ? parseIntField(parsed.fields.totalQty, item.totalQty) : item.totalQty;
  const transitQty = parsed.fields.transitQty !== undefined ? parseIntField(parsed.fields.transitQty, item.transitQty) : item.transitQty;
  const shelfQty = totalQty - transitQty;

  if (totalQty < 1) throw appError('validation_failed', { field: 'totalQty' });
  if (shelfQty < 0) throw appError('validation_failed', { field: 'transitQty' });

  const existingProductId = parsed.fields.existingProductId ? String(parsed.fields.existingProductId).trim() : null;
  if (existingProductId) {
    const exists = await Product.exists({ _id: existingProductId });
    if (!exists) throw appError('validation_failed', { field: 'existingProductId' });
  }
  const deliveryGroupIds = safeParseArray(parsed.fields.deliveryGroupIds);
  if (deliveryGroupIds === null) {
    throw appError('validation_failed', { field: 'deliveryGroupIds' });
  }
  if (deliveryGroupIds.length > 0) {
    const existingCount = await DeliveryGroup.countDocuments({ _id: { $in: deliveryGroupIds } });
    if (existingCount !== deliveryGroupIds.length) {
      throw appError('validation_failed', { field: 'deliveryGroupIds' });
    }
  }
  const qtyPerShop = parseIntField(parsed.fields.qtyPerShop);

  // Capture values before changes for diff
  const _oldSnapshot = {
    name: item.name,
    totalQty: item.totalQty,
    transitQty: item.transitQty,
    shelfQty: item.shelfQty,
    price: item.price,
    qtyPerPackage: item.qtyPerPackage,
    qtyPerShop: item.qtyPerShop,
    barcode: item.barcode,
    photoUrl: item.photoUrl,
  };

  item.totalQty = totalQty;
  item.transitQty = transitQty;
  item.shelfQty = shelfQty;
  item.deliveryGroupIds = deliveryGroupIds;
  item.qtyPerShop = qtyPerShop;
  if (parsed.fields.name !== undefined) item.name = String(parsed.fields.name).trim();
  if (parsed.fields.price !== undefined) item.price = parsed.fields.price !== '' ? Number(parsed.fields.price) : null;
  if (parsed.fields.qtyPerPackage !== undefined) item.qtyPerPackage = Number(parsed.fields.qtyPerPackage) || 1;
  if (parsed.fields.barcode !== undefined) item.barcode = String(parsed.fields.barcode).trim();
  item.existingProductId = existingProductId || null;

  const file = parsed.files?.[0];
  if (file) {
    const filename = await uploadToR2(file.buffer, file.originalname, file.mimetype);
    item.photoUrl = `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/products/${filename}`;
    item.photoName = file.originalname || filename;
  } else if (!item.photoUrl && existingProductId) {
    const existingProduct = await Product.findById(existingProductId).lean();
    if (existingProduct) {
      item.photoUrl = existingProduct.imageUrls?.[0] || existingProduct.localImageUrl || item.photoUrl;
      item.photoName = existingProduct.imageNames?.[0] || existingProduct.imageUrls?.[0] || item.photoName;
    }
  }

  // Save item AND re-check receipt.status='draft' in the SAME transaction so
  // that a concurrent commit (which CAS-flips status to 'completed') will
  // either run before us (we abort with 409) or run after us (it sees our
  // changes). Без цього вікно між початковою перевіркою і item.save() могло
  // дати «змінив позицію вже завершеної накладної».
  const txSession = await mongoose.connection.startSession();
  try {
    await txSession.withTransaction(async () => {
      const liveReceipt = await Receipt.findOne(
        { _id: req.params.id, status: 'draft' },
        '_id status',
      ).session(txSession);
      if (!liveReceipt) throw appError('receipt_completed_locked');
      await item.save({ session: txSession });
    });
  } finally {
    txSession.endSession();
  }

  // Log: which fields changed and who changed them
  const _newSnapshot = {
    name: item.name,
    totalQty: item.totalQty,
    transitQty: item.transitQty,
    shelfQty: item.shelfQty,
    price: item.price,
    qtyPerPackage: item.qtyPerPackage,
    qtyPerShop: item.qtyPerShop,
    barcode: item.barcode,
    photoUrl: item.photoUrl,
  };
  const _logChanges = Object.entries(_oldSnapshot)
    .filter(([field]) => String(_oldSnapshot[field] ?? '') !== String(_newSnapshot[field] ?? ''))
    .map(([field]) => ({ field, label: FIELD_LABELS[field] || field, from: _oldSnapshot[field], to: _newSnapshot[field] }));
  if (_logChanges.length > 0) {
    ReceiptItemLog.create({
      receiptId: receipt._id,
      itemId: item._id,
      itemName: item.name,
      action: 'update',
      actor: getActor(req),
      changes: _logChanges,
    }).catch((e) => console.error('[ReceiptItemLog] update error:', e));
  }

  // If barcode was explicitly submitted and there's a linked existing product, enrich the Product record.
  // We also set barcodeChecked: true when the field is empty — that means the user confirmed "no barcode".
  if (parsed.fields.barcode !== undefined && item.existingProductId) {
    const newBarcode = String(parsed.fields.barcode).trim();
    const update = { barcodeChecked: true };
    if (newBarcode) update.barcode = newBarcode;
    await Product.findByIdAndUpdate(item.existingProductId, { $set: update });
  }

  const io = getIO();
  if (io) io.to(`receipt_${req.params.id}`).emit('receipt_item_updated', item);

  res.json(item);
}));

// ВИДАЛЕННЯ ПОЗИЦІЇ (DELETE)
router.delete('/:id/items/:itemId', staffOnly, asyncHandler(async (req, res) => {
  const session = await mongoose.connection.startSession();
  try {
    let deletedItem = null;

    await session.withTransaction(async () => {
      // Атомарна перевірка статусу + delete у одній сесії: захищає від race
      // condition «commit накладної проскочив після перевірки, до видалення».
      const receipt = await Receipt.findOne(
        { _id: req.params.id },
        '_id status',
      ).session(session);
      if (!receipt) throw appError('receipt_not_found');
      if (receipt.status !== 'draft') throw appError('receipt_completed_no_delete');

      const item = await ReceiptItem.findOneAndDelete(
        { _id: req.params.itemId, receiptId: req.params.id },
        { session },
      );
      if (!item) throw appError('receipt_item_not_found');
      deletedItem = item;
    });

    // Аудит-лог видалення позиції — обов'язковий слід для розслідувань
    // (раніше DELETE не писав у ReceiptItemLog взагалі).
    ReceiptItemLog.create({
      receiptId: req.params.id,
      itemId: deletedItem._id,
      itemName: deletedItem.name || '',
      action: 'delete',
      actor: getActor(req),
      changes: [
        { field: 'name', label: FIELD_LABELS.name, from: deletedItem.name, to: null },
        { field: 'totalQty', label: FIELD_LABELS.totalQty, from: deletedItem.totalQty, to: null },
        { field: 'price', label: FIELD_LABELS.price, from: deletedItem.price, to: null },
      ],
    }).catch((e) => console.error('[ReceiptItemLog] delete error:', e));

    const io = getIO();
    if (io) io.to(`receipt_${req.params.id}`).emit('receipt_item_deleted', req.params.itemId);

    res.json({ message: 'Позицію видалено' });
  } finally {
    session.endSession();
  }
}));

router.post('/:id/commit', staffOnly, asyncHandler(async (req, res) => {
  // Cheap pre-flight (avoids opening a session for the obviously-bad case).
  const receiptCheck = await Receipt.findById(req.params.id).lean();
  if (!receiptCheck) throw appError('receipt_not_found');
  if (receiptCheck.status === 'completed') throw appError('receipt_already_completed');

  const session = await mongoose.connection.startSession();
  session.startTransaction();

  try {
    // Atomic CAS: draft → completed. Виконуємо ПЕРШИМ кроком транзакції, щоб
    // паралельний PATCH/DELETE item (який теж перевіряє status='draft' у своїй
    // транзакції) гарантовано побачив новий статус і відмовив запит, а не
    // переписав/видалив позицію вже після нашої перевірки.
    const receipt = await Receipt.findOneAndUpdate(
      { _id: req.params.id, status: 'draft' },
      { $set: { status: 'completed', completedAt: new Date() } },
      { new: true, session },
    );
    if (!receipt) {
      await session.abortTransaction();
      session.endSession();
      throw appError('receipt_already_completed');
    }

    // Re-load items INSIDE the transaction — таким чином усі зміни, які
    // могли пройти між pre-check і CAS, вже або встигли (і ми бачимо актуальний
    // стан), або заблоковані статус-CAS-ом у власних транзакціях.
    const items = await ReceiptItem.find({ receiptId: receipt._id }).session(session);
    if (!items.length) throw appError('receipt_no_items');

    const invalidItem = items.find((item) => !item.name || item.price === null || item.price <= 0);
    if (invalidItem) throw appError('receipt_items_incomplete');

    const pendingItem = items.find((item) => item.warehousePending);
    if (pendingItem) throw appError('receipt_item_pending', { name: pendingItem.name });

    const orphanTransit = items.find(
      (item) => item.transitQty > 0 && (!item.deliveryGroupIds || item.deliveryGroupIds.length === 0),
    );
    if (orphanTransit) {
      throw appError('receipt_item_orphan_transit', {
        name: orphanTransit.name,
        transitQty: orphanTransit.transitQty,
      });
    }

    const createdProducts = [];

    // 4.1: Pre-determine how many NEW products will be created (no existingProductId or not found),
    // then do ONE bulk shiftUp instead of one per new product.
    const existingIdSet = new Set(
      items.filter((i) => i.existingProductId).map((i) => String(i.existingProductId))
    );
    let resolvedExistingCount = 0;
    if (existingIdSet.size > 0) {
      resolvedExistingCount = await Product.countDocuments({
        _id: { $in: [...existingIdSet] },
      }).session(session);
    }
    const newProductCount = items.length - resolvedExistingCount;
    if (newProductCount > 0) {
      await Product.updateMany(
        { orderNumber: { $gte: 1 } },
        { $inc: { orderNumber: newProductCount } },
        { session }
      );
    }
    let nextOrderNumber = 1;

    // 4.2: Track already-updated existingProductIds to prevent double-increment if two items share the same product.
    const usedExistingProductIds = new Set();

    for (const item of items) {
      let currentProduct;

      // 1. Update or create the product
      if (item.existingProductId && !usedExistingProductIds.has(String(item.existingProductId))) {
        usedExistingProductIds.add(String(item.existingProductId));
        currentProduct = await Product.findById(item.existingProductId).session(session);
        if (currentProduct) {
          currentProduct.quantity += item.shelfQty;
          if (item.price !== null) currentProduct.price = item.price;
          if (item.qtyPerPackage) currentProduct.quantityPerPackage = item.qtyPerPackage;
          await currentProduct.save({ session });
          item.createdProductId = currentProduct._id;
          await item.save({ session });
        }
      }

      if (!currentProduct) {
        currentProduct = new Product({
          orderNumber: nextOrderNumber++,
          price: item.price,
          quantity: item.shelfQty,
          warehouse: '',
          category: '',
          brand: item.name || '',
          model: '',
          status: 'pending',
          source: 'receipt',
          imageUrls: [item.photoUrl],
          imageNames: [item.photoName],
          barcode: item.barcode || '',
          quantityPerPackage: item.qtyPerPackage || 0,
        });

        await currentProduct.save({ session });
        item.createdProductId = currentProduct._id;
        await item.save({ session });
      }

      createdProducts.push(currentProduct);

      // 2. Transit allocation
      if (item.transitQty > 0 && item.deliveryGroupIds && item.deliveryGroupIds.length > 0) {
        // New architecture: users carry shopId; legacy users carry deliveryGroupId directly.
        const shops = await Shop.find(
          { deliveryGroupId: { $in: item.deliveryGroupIds }, isActive: true },
          '_id'
        ).session(session).lean();
        const shopIds = shops.map((s) => s._id);
        const targetUsers = await User.find({
          $or: [
            { shopId: { $in: shopIds } },
            { deliveryGroupId: { $in: item.deliveryGroupIds } },
          ],
          role: 'seller',
        }).session(session).lean();

        if (targetUsers.length > 0) {
          // 4.4: Fisher-Yates shuffle for unbiased random distribution
          const shuffledUsers = [...targetUsers];
          for (let i = shuffledUsers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffledUsers[i], shuffledUsers[j]] = [shuffledUsers[j], shuffledUsers[i]];
          }
          const packSize = Math.max(1, item.qtyPerPackage || 1);
          const baseQty = item.qtyPerShop > 0
            ? item.qtyPerShop
            : Math.floor(item.transitQty / targetUsers.length);

          let remainingTransit = item.transitQty;
          const allocations = shuffledUsers.map((user) => ({ user, qty: 0 }));

          if (baseQty > 0) {
            for (const alloc of allocations) {
              if (remainingTransit >= baseQty) {
                alloc.qty += baseQty;
                remainingTransit -= baseQty;
              } else {
                break;
              }
            }
          }

          // Distribute remainder 1 pack at a time — guarded against empty allocations or invalid packSize
          let i = 0;
          while (remainingTransit > 0) {
            if (allocations.length === 0 || packSize < 1) break;
            const addQty = Math.min(remainingTransit, packSize);
            allocations[i % allocations.length].qty += addQty;
            remainingTransit -= addQty;
            i++;
          }

          for (const alloc of allocations) {
            if (alloc.qty <= 0) continue;
            const idempotencyKey = `direct_${receipt._id}_${currentProduct._id}_${alloc.user.telegramId}`;
            // Pre-check prevents E11000 inside the transaction (any duplicate error in a session aborts it)
            if (await Order.exists({ idempotencyKey }).session(session)) continue;
            const directOrder = new Order({
              buyerTelegramId: alloc.user.telegramId,
              orderType: 'direct_allocation',
              receiptId: receipt._id,
              status: 'confirmed',
              items: [{
                productId: currentProduct._id,
                name: currentProduct.brand || currentProduct.model || item.name,
                price: currentProduct.price,
                quantity: alloc.qty,
              }],
              totalPrice: currentProduct.price * alloc.qty,
              idempotencyKey,
            });
            await directOrder.save({ session });
          }
        }
      }
    }

    await session.commitTransaction();
    session.endSession();

    ReceiptItemLog.create({
      receiptId: receipt._id,
      itemName: receipt.receiptNumber,
      action: 'receipt_complete',
      actor: getActor(req),
    }).catch((e) => console.error('[ReceiptItemLog] receipt_complete error:', e));

    // Notify warehouse board that new products are available in the incoming strip
    try { getIO().emit('incoming_updated'); } catch (_) {}

    res.json({ receipt, createdProductsCount: createdProducts.length });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    // AppError instances are already user-facing; rethrow so the central handler
    // turns them into proper JSON. Anything else becomes a generic commit failure.
    if (err && err.name === 'AppError') throw err;
    console.error('[receipts.commit] Error:', err);
    throw appError('receipt_commit_failed');
  }
}));

// ── RESOLVE WAREHOUSE-PENDING ─────────────────────────────────────────────
// Link a warehousePending item to an existing product, or mark it as a brand-new product.
router.patch('/:id/items/:itemId/link', staffOnly, asyncHandler(async (req, res) => {
  const { existingProductId, markAsNew, keepNewPhoto } = req.body || {};
  const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id });
  if (!item) throw appError('receipt_item_not_found');

  if (existingProductId) {
    item.existingProductId = existingProductId;
    const prod = await Product.findById(existingProductId);
    if (prod) {
      if (item.photoUrl && keepNewPhoto === true) {
        // User chose the NEW photo — update the product record so it shows everywhere
        prod.imageUrls = [item.photoUrl, ...(prod.imageUrls || []).filter((u) => u !== item.photoUrl)];
        if (item.photoName) {
          prod.imageNames = [item.photoName, ...(prod.imageNames || []).filter((n) => n !== item.photoName)];
        }
        await prod.save();
      } else if (!item.photoUrl || keepNewPhoto === false) {
        // User chose the OLD photo (or item had no photo) — pull from product
        item.photoUrl = prod.imageUrls?.[0] || prod.localImageUrl || '';
        item.photoName = prod.imageNames?.[0] || '';
      }
      if (!item.name || item.name === 'Без назви') {
        item.name = prod.brand || prod.model || item.name;
      }
      if (item.price == null && prod.price != null) {
        item.price = prod.price;
      }
    }
  }
  item.warehousePending = false;
  await item.save();

  ReceiptItemLog.create({
    receiptId: req.params.id,
    itemId: item._id,
    itemName: item.name,
    action: 'resolve_pending',
    actor: getActor(req),
    meta: { existingProductId: existingProductId || null, markAsNew: !!markAsNew },
  }).catch((e) => console.error('[ReceiptItemLog] resolve_pending error:', e));

  // Return enriched item (same as GET /:id/items enrichment)
  const productId = item.existingProductId || item.createdProductId;
  let enriched = item.toObject();
  if (productId) {
    const [prod, block] = await Promise.all([
      Product.findById(productId, 'quantity status barcodeChecked barcode price').lean(),
      Block.findOne({ productIds: productId }, 'blockId').lean(),
    ]);
    enriched.currentLocation = { blockId: block?.blockId ?? null, status: prod?.status ?? null };
    enriched.productCurrentQty = prod?.quantity ?? null;
    enriched.barcodeChecked = prod?.barcodeChecked ?? false;
  } else {
    enriched.currentLocation = { blockId: null, status: null };
    enriched.productCurrentQty = null;
  }

  const io = getIO();
  if (io) io.to(`receipt_${req.params.id}`).emit('receipt_item_updated', enriched);

  res.json(enriched);
}));

// ── HISTORY / AUDIT LOG ────────────────────────────────────────────────────

// GET all logs for a receipt (lazy — only called when user explicitly opens history)
router.get('/:id/logs', staffOnly, asyncHandler(async (req, res) => {
  const logs = await ReceiptItemLog.find({ receiptId: req.params.id })
    .sort({ createdAt: -1 })
    .lean();
  res.json(logs);
}));

// POST a move_to_block action from the frontend (addToBlock lives in blocks route, not here)
router.post('/:id/items/:itemId/log', staffOnly, asyncHandler(async (req, res) => {
  const { action, blockId, itemName } = req.body || {};
  if (!action) throw appError('receipt_log_action_required');

  await ReceiptItemLog.create({
    receiptId: req.params.id,
    itemId: req.params.itemId,
    itemName: itemName || '',
    action,
    actor: getActor(req),
    meta: blockId ? { blockId } : {},
  });
  res.json({ ok: true });
}));

module.exports = router;
