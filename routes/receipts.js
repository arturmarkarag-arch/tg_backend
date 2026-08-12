const express = require('express');
const mongoose = require('mongoose');
const Busboy = require('busboy');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const Receipt = require('../models/Receipt');
const ReceiptItem = require('../models/ReceiptItem');
const Product = require('../models/Product');
const Block = require('../models/Block');
const ReceiptItemLog = require('../models/ReceiptItemLog');
const DeliveryGroup = require('../models/DeliveryGroup');
const Counter = require('../models/Counter');
const { getIO } = require('../socket');
const { upsertShopOwnedFromReceiptItem, syncMirror } = require('../utils/upsertShopProduct');
const { embedShopProductAsync } = require('../utils/shopProductEmbedding');
const { embedProductAsync } = require('../utils/productEmbedding');
const { getGeminiStatus } = require('../geminiClient');
const { describeImageUrl } = require('../utils/productDescribe');
const { appError, asyncHandler } = require('../utils/errors');
const {
  assertCanEditItem,
  assertCanDeleteItem,
  assertCanConfirmItem,
  assertItemReadyToConfirm,
} = require('../utils/receiptPermissions');
// Проведена накладна редагується так само, як відкрита; весь контракт
// «правка позиції → товар, дзеркало, вектор, дозамовлення» живе в одному місці.
const {
  labelPositionsFromMeta,
  snapshotItem,
  describeItemUsage,
  propagateItemEdit,
  rollbackItemArtifacts,
  hasOpenSupplementWave,
} = require('../services/receiptSync');

const staffOnly = requireTelegramRoles(['admin', 'warehouse']);

const FIELD_LABELS = {
  totalQty: 'Загальна к-сть',
  destination: 'Куди',
  price: 'Ціна',
  qtyPerPackage: 'В упаковці',
  qtyPerShop: 'На магазин',
  photoUrl: 'Фото',
};

async function ensureReceiptItemProduct(item, session) {
  // Shop-routed goods never touch warehouse stock.
  if ((item.destination || 'shelf') === 'shops') return null;

  let product = null;

  // Idempotency: once this receipt item created a warehouse Product, reuse it.
  if (item.createdProductId) {
    product = await Product.findById(item.createdProductId).session(session);
    if (product) {
      if (!item.stockApplied) {
        product.quantity = item.totalQty;
      }
      if (item.price !== null) product.price = item.price;
      if (item.qtyPerPackage) product.quantityPerPackage = item.qtyPerPackage;
      if (!product.shelvedAt) product.shelvedAt = new Date();
      await product.save({ session });
      if (!item.stockApplied) {
        item.stockApplied = true;
        await item.save({ session });
      }
      return product;
    }
  }

  const maxProduct = await Product.findOne(
    { status: { $ne: 'archived' } },
    'orderNumber',
  ).sort({ orderNumber: -1 }).session(session).lean();
  const nextOrderNumber = (maxProduct?.orderNumber ?? 0) + 1;
  const labelPositions = labelPositionsFromMeta(item.photoMeta);

  product = new Product({
    orderNumber: nextOrderNumber,
    price: item.price ?? 0,
    quantity: item.totalQty,
    warehouse: '',
    category: '',
    name: item.name || '',
    brand: item.name || '',
    model: '',
    status: 'pending',
    shelvedAt: new Date(),
    source: 'receipt',
    imageUrls: [item.photoUrl],
    imageNames: [item.photoName],
    originalImageUrl: item.originalPhotoUrl || '',
    labelPositions,
    quantityPerPackage: item.qtyPerPackage || 0,
    aiDescription: item.aiDescription || '',
  });

  try {
    await product.save({ session });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.orderNumber) {
      throw appError('product_order_number_conflict');
    }
    throw err;
  }

  item.createdProductId = product._id;
  item.stockApplied = true;
  await item.save({ session });
  return product;
}

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
  } catch (err) {
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
        files.push({ field: name, buffer: Buffer.concat(chunks), originalname: info.filename, mimetype: info.mimeType });
      });
    });

    busboy.on('close', () => resolve({ fields, files }));
    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

/** Build the public URL for an uploaded object in the given folder. */
function r2Url(folder, filename) {
  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${folder}/${filename}`;
}

// Sanitize a client-supplied R2 filename (the photo/original are uploaded direct
// to R2 by the browser; only the filename comes back). Rejects path traversal.
function safeUploadName(v) {
  const s = String(v || '').trim();
  return /^[a-zA-Z0-9._-]+\.(jpg|jpeg|png|webp)$/i.test(s) ? s : '';
}

/** Parses a form-field string to a safe non-negative integer. Returns fallback on NaN/negative/missing. */
function parseIntField(val, fallback = 0) {
  const n = Math.trunc(Number(val));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Parses a form-field string to a finite number (price, qtyPerPackage).
 * Returns null if the field is absent or empty; throws validation_failed if
 * the value is present but not a finite number (NaN, Infinity, text).
 */
function parseNumberField(val, fieldName) {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n)) throw appError('validation_failed', { field: fieldName });
  return n;
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

/** Parses a JSON object field. Returns null when absent, object on success, undefined on bad JSON. */
function safeParseObject(val) {
  if (val === undefined || val === '' || val === null) return null;
  try {
    const obj = JSON.parse(val);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : undefined;
  } catch {
    return undefined;
  }
}

const router = express.Router();

router.get('/', staffOnly, asyncHandler(async (req, res) => {
  const statusFilter = req.query.status;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));

  const query = {};
  if (statusFilter) query.status = statusFilter;

  // Date range filter on createdAt. dateTo is treated as inclusive end-of-day.
  const createdAt = {};
  const fromMs = Date.parse(req.query.dateFrom || '');
  const toMs = Date.parse(req.query.dateTo || '');
  if (Number.isFinite(fromMs)) createdAt.$gte = new Date(fromMs);
  if (Number.isFinite(toMs)) createdAt.$lte = new Date(toMs + 24 * 60 * 60 * 1000 - 1);
  if (Object.keys(createdAt).length) query.createdAt = createdAt;

  // Free-text search by receipt number (escaped, case-insensitive).
  const q = String(req.query.q || '').trim();
  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.receiptNumber = { $regex: escaped, $options: 'i' };
  }

  const SORTS = {
    date_desc: { createdAt: -1 },
    date_asc: { createdAt: 1 },
    number_desc: { receiptNumber: -1 },
    number_asc: { receiptNumber: 1 },
  };
  const sortSpec = SORTS[req.query.sort] || SORTS.date_desc;

  const [total, receipts] = await Promise.all([
    Receipt.countDocuments(query),
    Receipt.find(query)
      .sort(sortSpec)
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

// Read-only photo feed for the Receipts page. It reads receipt metadata in one
// batch so the UI can explain destination, but it never mutates receipt state
// or touches confirm/commit logic.
router.get('/items-gallery', staffOnly, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
  const query = {
    photoUrl: { $exists: true, $nin: ['', null] },
  };

  const [total, items] = await Promise.all([
    ReceiptItem.countDocuments(query),
    ReceiptItem.find(query, '_id photoUrl totalQty destination receiptId')
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
  ]);

  // One batched lookup gives the gallery enough receipt context to explain
  // where the photographed item went without turning this read-only feed into
  // an N+1 query. Supplement receipts are always warehouse-bound as well, so
  // the client can label them truthfully as "Допродаж + склад".
  const receiptIds = [...new Set(items.map((item) => String(item.receiptId)).filter(Boolean))];
  const receipts = receiptIds.length
    ? await Receipt.find({ _id: { $in: receiptIds } }, '_id type').lean()
    : [];
  const receiptMap = new Map(receipts.map((receipt) => [String(receipt._id), receipt]));
  const galleryItems = items.map((item) => {
    const receipt = receiptMap.get(String(item.receiptId));
    return {
      ...item,
      receiptType: receipt?.type || 'regular',
    };
  });

  res.json({
    items: galleryItems,
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

async function getNextReceiptNumber() {
  const counter = await Counter.findOneAndUpdate(
    { name: 'receiptNumber' },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return `REC-${String(counter.seq).padStart(4, '0')}`;
}

const RECEIPT_TYPES = ['regular', 'supplement'];

router.post('/', staffOnly, asyncHandler(async (req, res) => {
  // Тип задається ОДИН раз, тут. Далі він визначає і дозволені призначення
  // позицій, і те, що станеться при проведенні (див. POST /:id/commit).
  const type = String(req.body?.type || 'regular');
  if (!RECEIPT_TYPES.includes(type)) throw appError('receipt_type_invalid');

  const receiptNumber = await getNextReceiptNumber();
  const receipt = new Receipt({
    receiptNumber,
    status: 'draft',
    type,
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
  }).catch((e) => {});
  res.status(201).json(receipt);
}));

/**
 * PATCH /:id — зміна типу накладної.
 *
 * Дозволено ЛИШЕ поки накладна порожня і не проведена. Тип керує призначенням
 * позицій ('supplement' → тільки на склад), тож перемикання вже наповненої
 * накладної означало б тихо перекроїти сенс кожної позиції: рядок «на магазини»
 * раптом став би товаром дозамовлення, який ніхто не переперевіряв.
 * Порожня накладна такої історії не має — там це просто виправлення описки.
 */
router.patch('/:id', staffOnly, asyncHandler(async (req, res) => {
  const type = String(req.body?.type || '');
  if (!RECEIPT_TYPES.includes(type)) throw appError('receipt_type_invalid');

  const receipt = await Receipt.findById(req.params.id);
  if (!receipt) throw appError('receipt_not_found');
  if (receipt.status !== 'draft') throw appError('receipt_already_completed');
  if (receipt.type === type) return res.json(receipt);

  const itemCount = await ReceiptItem.countDocuments({ receiptId: receipt._id });
  if (itemCount > 0) throw appError('receipt_type_locked');

  const from = receipt.type;
  receipt.type = type;
  await receipt.save();

  ReceiptItemLog.create({
    receiptId: receipt._id,
    itemName: receipt.receiptNumber,
    action: 'receipt_type_change',
    actor: getActor(req),
    changes: [{ field: 'type', label: 'Тип накладної', from, to: type }],
  }).catch((e) => {});

  res.json(receipt);
}));

/**
 * Додавання позиції — дозволене і в проведену накладну.
 *
 * Нова позиція завжди починається як 'draft': сам факт того, що накладну колись
 * провели, не підписує рядок, якого тоді не існувало. Товар з'явиться при
 * підтвердженні, тим самим шляхом, що й у відкритій накладній.
 *
 * Виняток — накладна-дозамовлення з уже закритим прийомом заявок: нову позицію
 * не буде кому показати, а відкривати нею хвилю заново неправильно.
 */
router.post('/:id/items', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id);
  if (!receipt) throw appError('receipt_not_found');
  if (receipt.type === 'supplement' && receipt.status === 'completed'
      && !(await hasOpenSupplementWave(receipt._id))) {
    throw appError('receipt_supplement_wave_closed');
  }

  if (!req.is('multipart/form-data')) throw appError('receipt_multipart_required');

  const parsed = await parseMultipart(req);
  // Main photo + clean original are uploaded straight to R2 by the browser; only
  // their sanitized filenames arrive here.
  const photoFilename    = safeUploadName(parsed.fields.photoFilename);
  const originalFilename = safeUploadName(parsed.fields.originalFilename);
  const photoMeta = safeParseObject(parsed.fields.photoMeta) || null;
  const deliveryGroupIds = safeParseArray(parsed.fields.deliveryGroupIds);
  if (deliveryGroupIds === null) throw appError('receipt_invalid_delivery_groups');
  if (deliveryGroupIds.length > 0) {
    const existingCount = await DeliveryGroup.countDocuments({ _id: { $in: deliveryGroupIds } });
    if (existingCount !== deliveryGroupIds.length) throw appError('receipt_delivery_groups_missing');
  }
  const qtyPerShop = parseIntField(parsed.fields.qtyPerShop);

  if (!photoFilename) throw appError('receipt_photo_required');

  const destination = String(parsed.fields.destination || 'shelf');
  if (!['shelf', 'shops'].includes(destination)) throw appError('receipt_destination_required');

  // КРИТИЧНЕ ПРАВИЛО: у накладній-дозамовленні кожна позиція йде НА СКЛАД.
  if (receipt.type === 'supplement' && destination !== 'shelf') {
    throw appError('receipt_supplement_shelf_only');
  }

  // Єдине поле фізичної кількості в накладній.
  const totalQty = parseIntField(parsed.fields.totalQty);
  if (!Number.isInteger(totalQty) || totalQty < 1) throw appError('receipt_qty_invalid');

  let photoUrl = r2Url('products', photoFilename);
  let photoName = photoFilename;
  let originalPhotoUrl = '';
  if (originalFilename) {
    originalPhotoUrl = r2Url('originals', originalFilename);
  }

  const receiptItem = new ReceiptItem({
    receiptId: receipt._id,
    createdBy: String(req.user.telegramId),
    status: 'draft',
    destination,
    photoUrl,
    photoName,
    originalPhotoUrl,
    photoMeta: photoMeta && typeof photoMeta === 'object'
      ? {
          comment: String(photoMeta.comment || ''),
          commentPos: {
            x: Number(photoMeta?.commentPos?.x) || 0.5,
            y: Number(photoMeta?.commentPos?.y) || 0.5,
          },
          pricePos: photoMeta.pricePos || null,
          qtyPos:   photoMeta.qtyPos || null,
        }
      : undefined,
    totalQty,
    deliveryGroupIds: Array.isArray(deliveryGroupIds) ? deliveryGroupIds : [],
    qtyPerShop,
    price: parseNumberField(parsed.fields.price, 'price'),
    qtyPerPackage: parseNumberField(parsed.fields.qtyPerPackage, 'qtyPerPackage'),
  });

  // Save item AND re-check that the receipt still exists in the SAME transaction,
  // so a concurrently deleted receipt can't leave an orphan item behind. Статус
  // тут більше не гейт: позиція, додана під час проведення, просто лишається
  // непідтвердженою в уже проведеній накладній — це підтримуваний стан.
  const addItemSession = await mongoose.connection.startSession();
  try {
    await addItemSession.withTransaction(async () => {
      const liveReceipt = await Receipt.findById(req.params.id, '_id status').session(addItemSession);
      if (!liveReceipt) throw appError('receipt_not_found');
      await receiptItem.save({ session: addItemSession });
    });
  } catch (txErr) {
    throw txErr;
  } finally {
    addItemSession.endSession();
  }

  // Log: who added this item
  ReceiptItemLog.create({
    receiptId: receipt._id,
    itemId: receiptItem._id,
    itemName: receiptItem.name,
    action: 'create',
    actor: getActor(req),
  }).catch((e) => {});

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
  const productIds = items.map((i) => i.createdProductId).filter(Boolean);
  let productMap = {};
  let blockMap = {};

  if (productIds.length > 0) {
    const [products, blocks] = await Promise.all([
      Product.find({ _id: { $in: productIds } }, 'quantity status').lean(),
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
    const productId = item.createdProductId;
    const product = productId ? productMap[String(productId)] : null;
    const blockId = productId ? (blockMap[String(productId)] ?? null) : null;
    return {
      ...item,
      currentLocation: { blockId, status: product?.status ?? null },
      productCurrentQty: product?.quantity ?? null,
    };
  });

  res.json(enrichedItems);
}));

/** Поля позиції, які показуються в журналі накладної. */
function logSnapshot(item) {
  return {
    totalQty: item.totalQty,
    destination: item.destination,
    price: item.price,
    qtyPerPackage: item.qtyPerPackage,
    qtyPerShop: item.qtyPerShop,
    photoUrl: item.photoUrl,
  };
}

// ОНОВЛЕННЯ ПОЗИЦІЇ (PATCH)
/**
 * Правка позиції дозволена В БУДЬ-ЯКИЙ ДЕНЬ, зокрема в проведеній накладній.
 *
 * Накладна — не заморожений папірець, а жива згадка про те, що приїхало: помилку
 * в ціні чи кількості помічають і назавтра. Тому статус накладної тут більше не
 * гейт; гейтом лишається лише те, чи товар уже поїхав далі (див. нижче зміну
 * призначення) та права з receiptPermissions.
 *
 * Кожна правка ОДРАЗУ протягується в похідні документи (propagateItemEdit):
 * складський товар + його дзеркало ShopProduct, або товар магазину. Кількість
 * застосовується РІЗНИЦЕЮ, бо залишок відтоді могли міняти вручну. Замовлення
 * не чіпаються: у них своя зафіксована ціна, і правка накладної не переписує
 * заднім числом уже погоджену з магазином суму.
 */
router.patch('/:id/items/:itemId', staffOnly, asyncHandler(async (req, res) => {
  if (!req.is('multipart/form-data')) {
    throw appError('validation_failed', { field: 'multipart/form-data is required' });
  }

  // Validate existence BEFORE consuming the body.
  const receipt = await Receipt.findById(req.params.id).lean();
  if (!receipt) throw appError('receipt_not_found');
  if (!(await ReceiptItem.exists({ _id: req.params.itemId, receiptId: req.params.id }))) {
    throw appError('receipt_item_not_found');
  }

  const parsed = await parseMultipart(req);

  // ── Розбір payload. `undefined` = поле не надсилали → лишається як є ───────
  let nextDestination;
  if (parsed.fields.destination !== undefined) {
    nextDestination = String(parsed.fields.destination);
    if (!['shelf', 'shops'].includes(nextDestination)) {
      throw appError('receipt_destination_required');
    }
    // Накладна-дозамовлення за поточним контрактом завжди приходить на склад.
    if (receipt.type === 'supplement' && nextDestination !== 'shelf') {
      throw appError('receipt_supplement_shelf_only');
    }
  }

  let nextTotalQty;
  if (parsed.fields.totalQty !== undefined) {
    nextTotalQty = parseIntField(parsed.fields.totalQty, 0);
    if (!Number.isInteger(nextTotalQty) || nextTotalQty < 1) throw appError('receipt_qty_invalid');
  }

  let nextDeliveryGroupIds;
  if (parsed.fields.deliveryGroupIds !== undefined) {
    nextDeliveryGroupIds = safeParseArray(parsed.fields.deliveryGroupIds);
    if (nextDeliveryGroupIds === null) {
      throw appError('validation_failed', { field: 'deliveryGroupIds' });
    }
    if (nextDeliveryGroupIds.length > 0) {
      const existingCount = await DeliveryGroup.countDocuments({ _id: { $in: nextDeliveryGroupIds } });
      if (existingCount !== nextDeliveryGroupIds.length) {
        throw appError('validation_failed', { field: 'deliveryGroupIds' });
      }
    }
  }

  let nextQtyPerShop;
  if (parsed.fields.qtyPerShop !== undefined) {
    nextQtyPerShop = parseIntField(parsed.fields.qtyPerShop, -1);
    if (!Number.isInteger(nextQtyPerShop) || nextQtyPerShop < 0) {
      throw appError('validation_failed', { field: 'qtyPerShop' });
    }
  }

  let nextPrice;
  if (parsed.fields.price !== undefined) nextPrice = parseNumberField(parsed.fields.price, 'price');
  let nextQtyPerPackage;
  if (parsed.fields.qtyPerPackage !== undefined) {
    nextQtyPerPackage = parseNumberField(parsed.fields.qtyPerPackage, 'qtyPerPackage');
  }

  let normalizedPhotoMeta = null;
  if (parsed.fields.photoMeta !== undefined) {
    const rawPhotoMeta = safeParseObject(parsed.fields.photoMeta);
    if (rawPhotoMeta === undefined) throw appError('validation_failed', { field: 'photoMeta' });
    if (rawPhotoMeta && typeof rawPhotoMeta === 'object') {
      normalizedPhotoMeta = {
        comment: String(rawPhotoMeta.comment || ''),
        commentPos: {
          x: Number(rawPhotoMeta?.commentPos?.x) || 0.5,
          y: Number(rawPhotoMeta?.commentPos?.y) || 0.5,
        },
        pricePos: rawPhotoMeta.pricePos || null,
        qtyPos: rawPhotoMeta.qtyPos || null,
      };
    }
  }

  const photoFilename = safeUploadName(parsed.fields.photoFilename);
  const originalFilename = safeUploadName(parsed.fields.originalFilename);

  const arraysEqual = (a = [], b = []) =>
    a.length === b.length && a.every((v, i) => String(v) === String(b[i]));

  let outcome = null;
  const txSession = await mongoose.connection.startSession();
  try {
    await txSession.withTransaction(async () => {
      outcome = null; // withTransaction може перезапустити колбек — скидаємо результат

      // Позицію перечитуємо ВСЕРЕДИНІ транзакції: різниця кількості рахується
      // від актуального значення, тож дві паралельні правки не загублять одна одну
      // (конфлікт запису → повторна спроба з новим читанням).
      const item = await ReceiptItem.findOne(
        { _id: req.params.itemId, receiptId: req.params.id },
      ).session(txSession);
      if (!item) throw appError('receipt_item_not_found');
      const liveReceipt = await Receipt.findById(req.params.id, '_id status type').session(txSession).lean();
      if (!liveReceipt) throw appError('receipt_not_found');
      const afterCommit = liveReceipt.status === 'completed';

      // Хвиля дозамовлення вже пішла продавцям: підписи на фото перемальовуються
      // разом з ціною (photoFilename), але ПІДМІНИТИ саму світлину (originalFilename
      // = нове знімання/галерея) не можна — магазин замовляв би одне, а приїхало б
      // інше. Перевірка живого статусу тут, а не до транзакції: накладну могли
      // провести саме поки вантажилось фото.
      if (liveReceipt.type === 'supplement' && afterCommit && originalFilename) {
        throw appError('receipt_supplement_photo_locked');
      }

      const destination = nextDestination ?? (item.destination || 'shelf');
      const totalQty = nextTotalQty ?? item.totalQty;
      const deliveryGroupIds = nextDeliveryGroupIds ?? (item.deliveryGroupIds || []);
      const qtyPerShop = nextQtyPerShop ?? (item.qtyPerShop || 0);

      const changedFields = [];
      if (nextPrice !== undefined && nextPrice !== item.price) changedFields.push('price');
      if (nextQtyPerPackage !== undefined && nextQtyPerPackage !== item.qtyPerPackage) {
        changedFields.push('qtyPerPackage');
      }
      if (destination !== (item.destination || 'shelf')) changedFields.push('destination');
      if (totalQty !== item.totalQty) changedFields.push('totalQty');
      if (nextDeliveryGroupIds !== undefined
          && !arraysEqual(deliveryGroupIds, item.deliveryGroupIds || [])) changedFields.push('deliveryGroupIds');
      if (nextQtyPerShop !== undefined && qtyPerShop !== (item.qtyPerShop || 0)) changedFields.push('qtyPerShop');
      if (photoFilename) changedFields.push('photoUrl');

      assertCanEditItem(req.user, item, changedFields);

      // ── Зміна призначення вже створеної позиції ─────────────────────────────
      // Складський товар і товар магазину — РІЗНІ сутності, а не прапорець на
      // одній. Перемкнути призначення можна, лише поки створеним товаром ще
      // ніхто не скористався: тоді старий товар прибирається начисто, позиція
      // повертається в 'draft', і повторне підтвердження створює новий у
      // правильному місці. Якщо товар уже в блоці/замовленні/збиранні — відмова
      // з поясненням; нишком архівувати його (і скасовувати позиції в
      // замовленнях магазинів) правка накладної не має права.
      const statusBefore = item.status;
      const rerouted = destination !== (item.destination || 'shelf')
        && !!(item.createdProductId || item.createdShopProductId);
      if (rerouted) {
        const usage = await describeItemUsage(item, { session: txSession });
        if (usage.inUse) throw appError('receipt_item_in_use', { reasons: usage.reasons.join('; ') });
        await rollbackItemArtifacts(item, { session: txSession });
        item.status = 'draft';
      }

      const before = logSnapshot(item);
      const prev = snapshotItem(item);

      item.totalQty = totalQty;
      item.destination = destination;
      item.deliveryGroupIds = deliveryGroupIds;
      item.qtyPerShop = qtyPerShop;
      if (nextPrice !== undefined) item.price = nextPrice;
      if (nextQtyPerPackage !== undefined) item.qtyPerPackage = nextQtyPerPackage;
      if (normalizedPhotoMeta) item.photoMeta = normalizedPhotoMeta;
      if (originalFilename) item.originalPhotoUrl = r2Url('originals', originalFilename);
      if (photoFilename) {
        item.photoUrl = r2Url('products', photoFilename);
        item.photoName = photoFilename;
      }

      await item.save({ session: txSession });

      // Товар, дзеркало і вектор оновлюються в ТІЙ САМІЙ транзакції, що й позиція:
      // накладна не може розійтися зі складом навіть на мить.
      const propagation = await propagateItemEdit(item, prev, { session: txSession });

      outcome = { item, before, after: logSnapshot(item), propagation, rerouted, statusBefore, afterCommit };
    });
  } finally {
    txSession.endSession();
  }

  const { item, before, after, propagation, rerouted, statusBefore, afterCommit } = outcome;

  const logChanges = Object.keys(before)
    .filter((field) => String(before[field] ?? '') !== String(after[field] ?? ''))
    .map((field) => ({
      field,
      label: FIELD_LABELS[field] || field,
      from: before[field],
      to: after[field],
    }));
  if (rerouted && statusBefore !== item.status) {
    logChanges.push({ field: 'status', label: 'Статус', from: statusBefore, to: item.status });
  }
  if (logChanges.length > 0) {
    ReceiptItemLog.create({
      receiptId: req.params.id,
      itemId: item._id,
      itemName: item.name,
      action: 'update',
      actor: getActor(req),
      changes: logChanges,
      // Скільки саме додалося/відняли на складі — головне питання при розборі
      // «чому залишок такий»; сам by-value залишок у логу позиції не видно.
      meta: {
        afterCommit,
        ...(propagation.quantityDelta ? { stockDelta: propagation.quantityDelta } : {}),
        ...(propagation.quantityClamped ? { stockClampedToZero: true } : {}),
        ...(propagation.productId ? { productId: propagation.productId } : {}),
        ...(propagation.shopProductId ? { shopProductId: propagation.shopProductId } : {}),
      },
    }).catch((e) => {});
  }

  // Нове фото → старий вектор бреше. Перегенерація ПІСЛЯ коміту (Gemini повільний
  // і не має тримати транзакцію), force — бо рядок вектора вже існує.
  if (propagation.reembed === 'warehouse') {
    embedProductAsync(propagation.reembedDoc, 'receipt-item-edit', { force: true });
  } else if (propagation.reembed === 'shop-owned') {
    embedShopProductAsync(propagation.reembedDoc, 'receipt-item-edit', { force: true });
  }

  const io = getIO();
  if (io) {
    io.to(`receipt_${req.params.id}`).emit('receipt_item_updated', item);
    // Правка проведеної накладної міняє живий товар — дошки складу мають це побачити.
    if (propagation.productId || propagation.shopProductId) io.emit('incoming_updated');
  }

  res.json(item);
}));

// ВИДАЛЕННЯ ПОЗИЦІЇ (DELETE)
/**
 * Видалити рядок можна і з проведеної накладної — але лише поки товар, який він
 * створив, нікуди не поїхав. Товар у блоці, в замовленні магазину чи в збиранні
 * не зникає через правку паперу: тоді приходить 409 зі списком причин, а забрати
 * товар зі складу можна свідомою архівацією на сторінці Складу.
 */
router.delete('/:id/items/:itemId', staffOnly, asyncHandler(async (req, res) => {
  const session = await mongoose.connection.startSession();
  try {
    let deletedItem = null;
    let removedArtifacts = null;

    await session.withTransaction(async () => {
      removedArtifacts = null; // withTransaction може перезапустити колбек
      const receipt = await Receipt.findById(req.params.id, '_id status').session(session);
      if (!receipt) throw appError('receipt_not_found');

      const item = await ReceiptItem.findOne(
        { _id: req.params.itemId, receiptId: req.params.id },
      ).session(session);
      if (!item) throw appError('receipt_item_not_found');

      // Only the worker who added it (or admin) may delete, and a confirmed item
      // is admin-only. Checked inside the txn so a concurrent confirm cannot slip
      // between the check and the delete.
      assertCanDeleteItem(req.user, item);

      // Позиція без створених документів (не підтверджена) — просто зникає.
      if (item.createdProductId || item.createdShopProductId) {
        const usage = await describeItemUsage(item, { session });
        if (usage.inUse) throw appError('receipt_item_in_use', { reasons: usage.reasons.join('; ') });
        removedArtifacts = await rollbackItemArtifacts(item, { session });
      }

      await item.deleteOne({ session });
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
        { field: 'totalQty', label: FIELD_LABELS.totalQty, from: deletedItem.totalQty, to: null },
        { field: 'price', label: FIELD_LABELS.price, from: deletedItem.price, to: null },
      ],
      // Що саме зникло разом з рядком — інакше «куди подівся товар» не відновити.
      meta: removedArtifacts || {},
    }).catch((e) => {});

    const io = getIO();
    if (io) {
      io.to(`receipt_${req.params.id}`).emit('receipt_item_deleted', req.params.itemId);
      if (removedArtifacts) io.emit('incoming_updated');
    }

    res.json({ message: 'Позицію видалено' });
  } finally {
    session.endSession();
  }
}));

// ── CONFIRM / UNCONFIRM A SINGLE ITEM ─────────────────────────────────────
// Only the worker who added the item (or an admin) may sign it off. A receipt
// can only be committed once every non-deleted item is confirmed.
//
// Підтвердження працює і в проведеній накладній: рядок, доданий після
// проведення, стає товаром тим самим шляхом, що й будь-який інший.
router.post('/:id/items/:itemId/confirm', staffOnly, asyncHandler(async (req, res) => {
  const session = await mongoose.connection.startSession();
  try {
    let confirmedItem = null;
    let receiptDoc = null;
    // ShopProducts that need (re)embedding — scheduled AFTER commit so we never
    // embed a doc that could still roll back. Reset on every transaction attempt.
    let embedTargets = [];
    await session.withTransaction(async () => {
      embedTargets = [];
      const receipt = await Receipt.findById(req.params.id).session(session);
      const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id }).session(session);
      if (!item) throw appError('receipt_item_not_found');
      if (!receipt) throw appError('receipt_not_found');
      receiptDoc = receipt;

      assertCanConfirmItem(req.user, item);
      assertItemReadyToConfirm(item);

      if (item.status !== 'confirmed') {
        item.status = 'confirmed';
        await item.save({ session });
      }

      const product = await ensureReceiptItemProduct(item, session);

      // Shop-catalog routing by destination — now INSIDE the stock transaction so
      // a warehouse Product can NEVER commit without its ShopProduct mirror, and a
      // shop-owned entry's back-link (createdShopProductId) is persisted atomically.
      // Previously these ran fire-and-forget after the txn: a crash/error there left
      // a confirmed Product with no mirror that nothing retried (re-confirm is
      // blocked once confirmed). Embeddings are deferred to after commit.
      if (product) {
        // shelf item → ShopProduct MIRROR of the warehouse product (linkedProductId set).
        // syncMirror CREATES the mirror if missing then PUSHES the warehouse's current
        // shared values, so a re-receipt into a product that already has a mirror can't
        // leave its price/qtyPerPackage/photo/description stale. In-transaction (session)
        // so a warehouse Product can never commit without its mirror.
        await syncMirror(product, { session });
        // Warehouse OWNS the Gemini vector (its ProductVector row); embed once
        // post-commit. embedProduct is idempotent — it skips when the row already
        // exists (re-receipt), so no gate is needed here. The mirror references this
        // same row at search time, so there is nothing separate to embed for it.
        if (product.originalImageUrl || product.imageUrls?.[0]) {
          embedTargets.push(['warehouse', product, 'receipt-confirm-warehouse']);
        }
      } else if ((item.destination || 'shelf') === 'shops') {
        // Shops item → shop-OWNED ShopProduct (no warehouse Product/stock).
        const sp = await upsertShopOwnedFromReceiptItem(item.toObject(), { session });
        if (sp && String(sp._id) !== String(item.createdShopProductId || '')) {
          item.createdShopProductId = sp._id;
          await item.save({ session });
        }
        if (sp && (sp.imageUrl || sp.originalImageUrl)) embedTargets.push(['shop-owned', sp, 'shop-owned-upsert']);
      }

      confirmedItem = item.toObject();
      confirmedItem.currentLocation = {
        blockId: null,
        status: product?.status ?? null,
      };
      confirmedItem.productCurrentQty = product?.quantity ?? null;
    });
    // Audit log AFTER commit (not inside the callback): withTransaction re-runs the
    // callback on a WriteConflict, so an in-callback create would write one log row
    // per attempt — and a row even if the transaction ultimately aborted.
    ReceiptItemLog.create({
      receiptId: confirmedItem.receiptId,
      itemId: confirmedItem._id,
      itemName: confirmedItem.name,
      action: 'confirm',
      actor: getActor(req),
      changes: [{ field: 'status', label: 'Статус', from: 'draft', to: 'confirmed' }],
    }).catch((e) => {});
    // Docs are now durable — schedule background Gemini embedding into ProductVector.
    // Warehouse products embed by productId; shop-owned items by shopProductId. Mirrors
    // are never embedded (they reference the warehouse row).
    for (const [kind, doc, reason] of embedTargets) {
      if (kind === 'warehouse') embedProductAsync(doc, reason);
      else                      embedShopProductAsync(doc, reason); // shop-owned
    }

    // Позиція, додана в УЖЕ проведену накладну-дозамовлення, має потрапити в ту
    // саму хвилю — інакше товар мовчки осів би на складі, а магазини його не
    // побачили. Створення ідемпотентне (унікальний {receiptItemId, deliveryGroupId}),
    // тому наздоганяє рівно нову позицію. Якщо прийом заявок уже закрито, нічого
    // не робимо: заново відкривати хвилю правкою накладної не можна.
    if (receiptDoc?.status === 'completed' && receiptDoc.type === 'supplement'
        && await hasOpenSupplementWave(receiptDoc._id)) {
      try {
        const { createOffersForReceipt } = require('../services/supplementOffers');
        const { created } = await createOffersForReceipt(receiptDoc._id);
        if (created.length) {
          for (const offer of created) {
            try {
              getIO()?.emit('supplement_opened', {
                offerId: String(offer._id),
                deliveryGroupId: String(offer.deliveryGroupId),
              });
            } catch (_) { /* сокет не критичний */ }
          }
          require('../services/supplementNotify').notifyOffers(created, 'opened').catch(() => {});
        }
      } catch (err) {
        // Товар уже на складі — це головне; звірятель supplementScheduler добʼє.
      }
    }

    const io = getIO();
    if (io) {
      io.to(`receipt_${req.params.id}`).emit('receipt_item_confirmed', confirmedItem);
      io.emit('incoming_updated');
    }
    res.json(confirmedItem);
  } finally {
    session.endSession();
  }
}));

/**
 * Зняти підтвердження — це ВІДКАТ позиції: створений нею товар (з дзеркалом,
 * вектором і пропозиціями дозамовлення) зникає, і рядок знову можна правити чи
 * видалити. Працює і в проведеній накладній.
 *
 * Єдина умова — товаром ще ніхто не скористався. Раніше товар у блоці просто
 * тихо лишався жити без підтвердженої позиції; тепер це явна відмова з
 * причиною, бо «зняв підтвердження, а товар усе одно на полиці» — саме той
 * мовчазний розрив між накладною і складом, який ця сторінка має виключати.
 */
router.post('/:id/items/:itemId/unconfirm', staffOnly, asyncHandler(async (req, res) => {
  const session = await mongoose.connection.startSession();
  try {
    let updatedItem = null;
    let didUnconfirm = false;
    let removedArtifacts = null;
    await session.withTransaction(async () => {
      didUnconfirm = false; // reset per attempt (withTransaction may re-run this)
      removedArtifacts = null;
      const receipt = await Receipt.findById(req.params.id, '_id status').session(session);
      const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id }).session(session);
      if (!item) throw appError('receipt_item_not_found');
      if (!receipt) throw appError('receipt_not_found');

      assertCanConfirmItem(req.user, item);

      if (item.status === 'confirmed') {
        if (item.createdProductId || item.createdShopProductId) {
          const usage = await describeItemUsage(item, { session });
          if (usage.inUse) throw appError('receipt_item_in_use', { reasons: usage.reasons.join('; ') });
          removedArtifacts = await rollbackItemArtifacts(item, { session });
        }

        item.status = 'draft';
        await item.save({ session });
        didUnconfirm = true;
      }

      updatedItem = item.toObject();
    });

    // Audit log AFTER commit — see the confirm handler note (avoid per-retry / phantom rows).
    if (didUnconfirm && updatedItem) {
      ReceiptItemLog.create({
        receiptId: updatedItem.receiptId,
        itemId: updatedItem._id,
        itemName: updatedItem.name,
        action: 'confirm',
        actor: getActor(req),
        changes: [{ field: 'status', label: 'Статус', from: 'confirmed', to: 'draft' }],
        meta: removedArtifacts || {},
      }).catch((e) => {});
    }

    const io = getIO();
    if (io) {
      io.to(`receipt_${req.params.id}`).emit('receipt_item_confirmed', updatedItem);
      io.emit('incoming_updated');
    }

    res.json(updatedItem);
  } finally {
    session.endSession();
  }
}));

/**
 * GET /:id/supplement-targets — стан кожної групи доставки для модалки проведення.
 *
 * Живе на накладній, а не в /api/supplement, бо це крок ПРИЙМАННЯ: його бачить
 * склад, а не продавець, і питання тут одне — «кому відкрити цю хвилю».
 *
 * Стан кожної групи тут — ІНФОРМАЦІЯ для працівника, а не правило допуску:
 * вибрати можна будь-яку групу, у якої є активні магазини. Тому список не
 * «застаріває» — те, що вікно замовлень закриється через хвилину після
 * відкриття модалки, на можливість проведення більше не впливає.
 */
router.get('/:id/supplement-targets', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id, 'type status').lean();
  if (!receipt) throw appError('receipt_not_found');
  if (receipt.type !== 'supplement') throw appError('receipt_not_supplement');

  const { describeSupplementTargets } = require('../services/supplementTargets');
  res.json(await describeSupplementTargets());
}));

router.post('/:id/commit', staffOnly, asyncHandler(async (req, res) => {
  // Cheap pre-flight (avoids opening a session for the obviously-bad case).
  const receiptCheck = await Receipt.findById(req.params.id).lean();
  if (!receiptCheck) throw appError('receipt_not_found');
  if (receiptCheck.status === 'completed') throw appError('receipt_already_completed');

  // ── Ціль хвилі дозамовлення ───────────────────────────────────────────────
  // Працівник сам обирає будь-яку групу. Статуси груп — лише інформація.
  // Закриття дозамовлення виконується вручну складом/адміном, без дедлайну.
  let supplementTarget = null;
  if (receiptCheck.type === 'supplement') {
    const { resolveSupplementTarget } = require('../services/supplementTargets');
    supplementTarget = await resolveSupplementTarget(req.body?.targetDeliveryGroupId);
    supplementTarget.openedAt = new Date();
  }

  const session = await mongoose.connection.startSession();
  session.startTransaction();

  try {
    // Atomic CAS: draft → completed. Виконуємо ПЕРШИМ кроком транзакції, щоб
    // паралельний PATCH/DELETE item (який теж перевіряє status='draft' у своїй
    // транзакції) гарантовано побачив новий статус і відмовив запит, а не
    // переписав/видалив позицію вже після нашої перевірки.
    const receipt = await Receipt.findOneAndUpdate(
      { _id: req.params.id, status: 'draft' },
      {
        $set: {
          status: 'completed',
          completedAt: new Date(),
          // Ціль хвилі стає частиною самого акту проведення: або накладна
          // проведена І має групу, або не проведена зовсім. Записати її окремим
          // апдейтом після коміту означало б вікно, у якому накладна вже
          // completed, а кому вона адресована — невідомо.
          ...(supplementTarget ? {
            targetDeliveryGroupId: supplementTarget.deliveryGroupId,
            supplementOpenedAt:    supplementTarget.openedAt,
            supplementClosesAt:    null,
            supplementStatus:      'pending',
          } : {}),
        },
      },
      { new: true, session },
    );
    if (!receipt) {
      // Do NOT abort/end here — the outer catch owns rollback. Aborting twice
      // on an already-ended session throws a secondary error that masks this
      // one. Just throw; the catch aborts the still-open transaction cleanly.
      throw appError('receipt_already_completed');
    }

    // Re-load items INSIDE the transaction — таким чином усі зміни, які
    // могли пройти між pre-check і CAS, вже або встигли (і ми бачимо актуальний
    // стан), або заблоковані статус-CAS-ом у власних транзакціях.
    const items = await ReceiptItem.find({ receiptId: receipt._id }).session(session);
    if (!items.length) throw appError('receipt_no_items');

    // Multi-worker gate: every item must be signed off by its owner first.
    const pendingConfirm = items.filter((item) => item.status !== 'confirmed').length;
    if (pendingConfirm > 0) {
      throw appError('receipt_items_not_all_confirmed', { pending: pendingConfirm });
    }

    // Every item is already confirmed at this point, so the item-level
    // completeness contract (photo + totalQty + price + qtyPerPackage) has
    // already been enforced. Commit consumes that signed-off state.

    // destination='shops' may exist without delivery groups; distribution to
    // sellers is a separate workflow and commit must not allocate automatically.

    const createdProducts = [];

    // Pre-determine how many warehouse Products still need a fallback create.
    // Normally confirm already created the Product; this keeps commit robust and
    // idempotent without any pre-existing-product matching path.
    const shelfItems = items.filter((i) => (i.destination || 'shelf') !== 'shops');
    const createdIdSet = new Set(
      shelfItems.map((i) => i.createdProductId).filter(Boolean).map(String),
    );
    let resolvedCreatedCount = 0;
    if (createdIdSet.size > 0) {
      resolvedCreatedCount = await Product.countDocuments({
        _id: { $in: [...createdIdSet] },
      }).session(session);
    }
    const newProductCount = shelfItems.length - resolvedCreatedCount;
    if (newProductCount > 0) {
      await Product.updateMany(
        { orderNumber: { $gte: 1 } },
        { $inc: { orderNumber: newProductCount } },
        { session },
      );
    }
    let nextOrderNumber = 1;

    for (const item of items) {
      // Shops items never create/update warehouse stock. Their shop-owned
      // catalog entry was handled at confirm time.
      if ((item.destination || 'shelf') === 'shops') continue;

      let currentProduct = null;
      const stockAlreadyApplied = !!item.stockApplied;

      if (item.createdProductId) {
        currentProduct = await Product.findById(item.createdProductId).session(session);
        if (currentProduct) {
          if (item.price !== null) currentProduct.price = item.price;
          if (item.qtyPerPackage) currentProduct.quantityPerPackage = item.qtyPerPackage;
          if (!stockAlreadyApplied) currentProduct.quantity = item.totalQty;
          await currentProduct.save({ session });
          // Проведення дописує в товар ціну/упаковку — отже, дзеркало теж мусить
          // їх побачити. Без цього правка ціни між підтвердженням і проведенням
          // лишала «Товари Магазинів» зі старою ціною назавжди.
          await syncMirror(currentProduct, { session });
          if (!stockAlreadyApplied) {
            item.stockApplied = true;
            await item.save({ session });
          }
        }
      }

      if (!currentProduct) {
        currentProduct = new Product({
          orderNumber: nextOrderNumber++,
          price: item.price ?? 0,
          quantity: item.totalQty,
          warehouse: '',
          category: '',
          name: item.name || '',
          brand: item.name || '',
          model: '',
          status: 'pending',
          source: 'receipt',
          imageUrls: [item.photoUrl],
          imageNames: [item.photoName],
          originalImageUrl: item.originalPhotoUrl || '',
          quantityPerPackage: item.qtyPerPackage || 0,
          aiDescription: item.aiDescription || '',
        });

        await currentProduct.save({ session });
        // Той самий інваріант, що й у підтвердженні: складський товар не існує
        // без свого дзеркала в «Товарах Магазинів».
        await syncMirror(currentProduct, { session });
        item.createdProductId = currentProduct._id;
        item.stockApplied = true;
        await item.save({ session });
      }

      createdProducts.push(currentProduct);
    }

    await session.commitTransaction();
    session.endSession();

    ReceiptItemLog.create({
      receiptId: receipt._id,
      itemName: receipt.receiptNumber,
      action: 'receipt_complete',
      actor: getActor(req),
    }).catch((e) => {});

    // Notify warehouse board that new products are available in the incoming strip
    try { getIO().emit('incoming_updated'); } catch (_) {}

    // ── Дозамовлення: запускається ПІСЛЯ проведення ВСІЄЇ накладної ───────────
    // Уся накладна — одна хвиля з одним дедлайном для однієї групи, тому
    // пропозиції відкриваються тут, а не при підтвердженні окремої позиції.
    //
    // Поза транзакцією свідомо: створення ідемпотентне (унікальний індекс
    // {receiptItemId, deliveryGroupId}), тому повторний виклик нічого не
    // задублює, а збій розсилки не має відкочувати вже проведену накладну.
    // Відповідь клієнту чекає на створення пропозицій (щоб «Проведено» і
    // «дозамовлення відкрито» не розповзалися в часі), а Telegram — ні.
    let supplementOffersCount = 0;
    if (supplementTarget) try {
      const { createOffersForReceipt } = require('../services/supplementOffers');
      // Часткова невдача НЕ кидає помилку: створене лишається створеним, а
      // накладна позначається supplementStatus:'pending' — звірятель у
      // supplementScheduler добʼє решту. Провести накладну вдруге неможливо,
      // тому «просто впасти тут» означало б втратити частину дозамовлень назавжди.
      const { created: offers } = await createOffersForReceipt(receipt._id);
      supplementOffersCount = offers.length;
      if (offers.length) {
        for (const offer of offers) {
          try {
            getIO()?.emit('supplement_opened', {
              offerId: String(offer._id),
              deliveryGroupId: String(offer.deliveryGroupId),
            });
          } catch (_) { /* сокет не критичний */ }
        }
        // Розсилка — фоном: Telegram буває повільним, а склад не має чекати на
        // нього, щоб побачити «Накладну проведено».
        require('../services/supplementNotify')
          .notifyOffers(offers, 'opened')
          .catch((e) => {});
      }
    } catch (err) {
      // Накладна вже проведена і товар на складі — це головне. Провал відкриття
      // дозамовлення логуємо, але не перетворюємо на помилку проведення.
    }

    res.json({
      receipt,
      createdProductsCount: createdProducts.length,
      supplementOffersCount,
      // Клієнт показує це в тості: для якої групи і до котрої години відкрито
      // хвилю. Без цього «Проведено» нічого не каже про головне — кому.
      supplementTarget: supplementTarget ? {
        deliveryGroupId: supplementTarget.deliveryGroupId,
      } : null,
    });
  } catch (err) {
    // Guard both: after a FAILED commitTransaction (e.g. a concurrent-commit
    // WriteConflict) the transaction is already terminal, so an unguarded
    // abortTransaction() throws a SECONDARY error that masks the real one and
    // crashes the handler to 500. Swallow teardown errors so the real cause below wins.
    try { await session.abortTransaction(); } catch { /* already terminal */ }
    try { session.endSession(); } catch { /* idempotent */ }
    // AppError instances are already user-facing; rethrow so the central handler
    // turns them into proper JSON. Anything else becomes a generic commit failure.
    if (err && err.name === 'AppError') throw err;
    if (err && err.name === 'CastError') throw err; // bad :id → global 400, not 500
    // Concurrent double-commit (двічі натиснули «Провести»): the other request won
    // the draft→completed CAS and our transaction hit a transient WriteConflict.
    // Surface a clean 409 (already completed), not a 500.
    const fresh = await Receipt.findById(req.params.id).lean();
    if (fresh && fresh.status === 'completed') throw appError('receipt_already_completed');
    throw appError('receipt_commit_failed');
  }
}));

// ── POST /:id/items/:itemId/describe — generate + cache the item description ──
// On-demand during receiving. Plain-language Ukrainian explainer from the item
// photo, cached on the ReceiptItem; copied into the warehouse Product /
// ShopProduct when this item is confirmed. Pressing again regenerates.
router.post('/:id/items/:itemId/describe', staffOnly, asyncHandler(async (req, res) => {
  const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id });
  if (!item) throw appError('receipt_item_not_found');

  const url = item.originalPhotoUrl || item.photoUrl || '';
  if (!url) return res.status(400).json({ error: 'photo_required', message: 'У позиції немає фото' });

  if (!getGeminiStatus().connected) {
    return res.status(503).json({ error: 'describe_not_configured', message: 'Опис недоступний: не підключено Gemini' });
  }

  try {
    const { text, name } = await describeImageUrl(url);
    if (!text) return res.status(502).json({ error: 'empty_description', message: 'Не вдалося згенерувати опис' });
    item.aiDescription = text;
    // Fill the name ONLY when the user left it blank — never clobber a manually
    // typed name with the model's guess.
    if (name && !String(item.name || '').trim()) item.name = name;
    await item.save();
    const io = getIO();
    if (io) io.to(`receipt_${req.params.id}`).emit('receipt_item_updated', item.toObject());
    res.json({ _id: item._id, aiDescription: item.aiDescription, name: item.name });
  } catch (err) {
    return res.status(502).json({ error: 'describe_api_error', message: err.message });
  }
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
