const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Busboy = require('busboy');
const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { shiftUp } = require('../utils/shiftOrderNumbers');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const Receipt = require('../models/Receipt');
const ReceiptItem = require('../models/ReceiptItem');
const Product = require('../models/Product');
const User = require('../models/User');
const Order = require('../models/Order');
const Block = require('../models/Block');
const ReceiptItemLog = require('../models/ReceiptItemLog');
const { getIO } = require('../socket');

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

router.get('/', staffOnly, async (req, res) => {
  try {
    const statusFilter = req.query.status;
    const query = {};
    if (statusFilter) {
      query.status = statusFilter;
    }

    const receipts = await Receipt.find(query).sort({ createdAt: -1 }).lean();
    const receiptsWithCounts = await Promise.all(receipts.map(async (receipt) => {
      const itemsCount = await ReceiptItem.countDocuments({ receiptId: receipt._id });
      return { ...receipt, itemsCount };
    }));

    res.json(receiptsWithCounts);
  } catch (err) {
    console.error('[receipts.list] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch receipts' });
  }
});

router.get('/:id', staffOnly, async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.id).lean();
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    res.json(receipt);
  } catch (err) {
    console.error('[receipts.get] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch receipt' });
  }
});

router.delete('/:id', staffOnly, async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    if (receipt.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft receipts can be deleted' });
    }

    const itemCount = await ReceiptItem.countDocuments({ receiptId: receipt._id });
    if (itemCount > 0) {
      return res.status(400).json({ error: 'Only empty receipts can be deleted' });
    }

    await receipt.deleteOne();
    res.json({ message: 'Receipt deleted' });
  } catch (err) {
    console.error('[receipts.delete] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete receipt' });
  }
});

router.post('/', staffOnly, async (req, res) => {
  try {
    const receiptNumber = `REC-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const receipt = new Receipt({
      receiptNumber,
      status: 'draft',
      createdBy: req.user.telegramId,
    });
    await receipt.save();
    ReceiptItemLog.create({
      receiptId: receipt._id,
      itemName: receipt.receiptNumber,
      action: 'receipt_create',
      actor: getActor(req),
    }).catch((e) => console.error('[ReceiptItemLog] receipt_create error:', e));
    res.status(201).json(receipt);
  } catch (err) {
    console.error('[receipts.create] Error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Receipt number already exists' });
    }
    res.status(500).json({ error: err.message || 'Failed to create receipt' });
  }
});

router.post('/:id/items', staffOnly, async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    if (receipt.status !== 'draft') {
      return res.status(409).json({ error: 'Cannot add items to a completed receipt' });
    }

    if (!req.is('multipart/form-data')) {
      return res.status(400).json({ error: 'multipart/form-data is required' });
    }

    const parsed = await parseMultipart(req);
    const file = parsed.files?.[0];
    const existingProductId = parsed.fields.existingProductId ? String(parsed.fields.existingProductId).trim() : null;
    const isWarehousePending = parsed.fields.warehousePending === 'true';
    const deliveryGroupIds = safeParseArray(parsed.fields.deliveryGroupIds);
    if (deliveryGroupIds === null) {
      return res.status(400).json({ error: 'Invalid deliveryGroupIds format' });
    }
    const qtyPerShop = parseIntField(parsed.fields.qtyPerShop);

    if (!file && !existingProductId) {
      return res.status(400).json({ error: 'Photo file is required when this is a new product' });
    }

    const totalQty = parseIntField(parsed.fields.totalQty);
    const transitQty = parseIntField(parsed.fields.transitQty);
    const shelfQty = totalQty - transitQty;

    if (totalQty < 1) {
      return res.status(400).json({ error: 'totalQty must be a positive integer' });
    }
    if (shelfQty < 0) {
      return res.status(400).json({ error: 'transitQty cannot exceed totalQty' });
    }

    let photoUrl;
    let photoName;
    if (file) {
      const filename = await uploadToR2(file.buffer, file.originalname, file.mimetype);
      photoUrl = `/api/products/images/${filename}`;
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
  } catch (err) {
    console.error('[receipts.items.create] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to add receipt item' });
  }
});

router.get('/:id/items', staffOnly, async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });

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
  } catch (err) {
    console.error('[receipts.items.list] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch receipt items' });
  }
});

// ОНОВЛЕННЯ ПОЗИЦІЇ (PATCH)
router.patch('/:id/items/:itemId', staffOnly, async (req, res) => {
  try {
    if (!req.is('multipart/form-data')) {
      return res.status(400).json({ error: 'multipart/form-data is required' });
    }

    // Validate receipt status and item existence BEFORE consuming the body
    const [receipt, item] = await Promise.all([
      Receipt.findById(req.params.id).lean(),
      ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id }),
    ]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!receipt || receipt.status !== 'draft') {
      return res.status(409).json({ error: 'Cannot modify a completed receipt' });
    }

    const parsed = await parseMultipart(req);

    const totalQty = parsed.fields.totalQty !== undefined ? parseIntField(parsed.fields.totalQty, item.totalQty) : item.totalQty;
    const transitQty = parsed.fields.transitQty !== undefined ? parseIntField(parsed.fields.transitQty, item.transitQty) : item.transitQty;
    const shelfQty = totalQty - transitQty;

    if (totalQty < 1) return res.status(400).json({ error: 'Invalid totalQty' });
    if (shelfQty < 0) return res.status(400).json({ error: 'transitQty cannot exceed totalQty' });

    const existingProductId = parsed.fields.existingProductId ? String(parsed.fields.existingProductId).trim() : null;
    const deliveryGroupIds = safeParseArray(parsed.fields.deliveryGroupIds);
    if (deliveryGroupIds === null) {
      return res.status(400).json({ error: 'Invalid deliveryGroupIds format' });
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
      item.photoUrl = `/api/products/images/${filename}`;
      item.photoName = file.originalname || filename;
    } else if (!item.photoUrl && existingProductId) {
      const existingProduct = await Product.findById(existingProductId).lean();
      if (existingProduct) {
        item.photoUrl = existingProduct.imageUrls?.[0] || existingProduct.localImageUrl || item.photoUrl;
        item.photoName = existingProduct.imageNames?.[0] || existingProduct.imageUrls?.[0] || item.photoName;
      }
    }

    await item.save();

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
  } catch (err) {
    console.error('[receipts.items.update] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to update item' });
  }
});

// ВИДАЛЕННЯ ПОЗИЦІЇ (DELETE)
router.delete('/:id/items/:itemId', staffOnly, async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.id).lean();
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    if (receipt.status !== 'draft') {
      return res.status(409).json({ error: 'Cannot delete items from a completed receipt' });
    }

    const item = await ReceiptItem.findOneAndDelete({ _id: req.params.itemId, receiptId: req.params.id });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const io = getIO();
    if (io) io.to(`receipt_${req.params.id}`).emit('receipt_item_deleted', req.params.itemId);

    res.json({ message: 'Item deleted' });
  } catch (err) {
    console.error('[receipts.items.delete] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete item' });
  }
});

router.post('/:id/commit', staffOnly, async (req, res) => {
  // Pre-flight checks (no session needed yet)
  const receiptCheck = await Receipt.findById(req.params.id).lean();
  if (!receiptCheck) return res.status(404).json({ error: 'Receipt not found' });
  if (receiptCheck.status === 'completed') {
    return res.status(409).json({ error: 'Receipt already completed' });
  }

  const items = await ReceiptItem.find({ receiptId: req.params.id });
  if (!items.length) {
    return res.status(400).json({ error: 'Receipt has no items' });
  }

  const invalidItem = items.find((item) => !item.name || item.price === null || item.price <= 0);
  if (invalidItem) {
    return res.status(400).json({ error: 'Не всі товари повністю описані' });
  }

  // Guard: unresolved warehouse-pending items
  const pendingItem = items.find((item) => item.warehousePending);
  if (pendingItem) {
    return res.status(422).json({
      error: `Позиція "${pendingItem.name || 'без назви'}" ще не прив'язана до складу. Знайдіть товар або оформіть як новий.`,
    });
  }

  // Guard: transit without delivery groups
  const orphanTransit = items.find(
    (item) => item.transitQty > 0 && (!item.deliveryGroupIds || item.deliveryGroupIds.length === 0),
  );
  if (orphanTransit) {
    return res.status(422).json({
      error: `Позиція "${orphanTransit.name || 'без назви'}" має транзит ${orphanTransit.transitQty} шт, але групи доставки не вказані`,
    });
  }

  const session = await mongoose.connection.startSession();
  session.startTransaction();

  try {
    // Atomic CAS: draft → completed (prevents double-commit race condition)
    const receipt = await Receipt.findOneAndUpdate(
      { _id: req.params.id, status: 'draft' },
      { $set: { status: 'completed', completedAt: new Date() } },
      { new: true, session },
    );
    if (!receipt) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({ error: 'Receipt not found or already completed' });
    }

    const createdProducts = [];

    for (const item of items) {
      let currentProduct;

      // 1. Update or create the product
      if (item.existingProductId) {
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
        await shiftUp({ orderNumber: { $gte: 1 } }, session);

        currentProduct = new Product({
          orderNumber: 1,
          price: item.price,
          quantity: item.shelfQty,
          warehouse: '',
          category: '',
          brand: item.name || '',
          model: '',
          status: 'pending',
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
        const targetUsers = await User.find({
          deliveryGroupId: { $in: item.deliveryGroupIds },
          role: 'seller',
        }).lean();

        if (targetUsers.length > 0) {
          const shuffledUsers = targetUsers.sort(() => 0.5 - Math.random());
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
    res.json({ receipt, createdProductsCount: createdProducts.length });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('[receipts.commit] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to commit receipt' });
  }
});

// ── RESOLVE WAREHOUSE-PENDING ─────────────────────────────────────────────
// Link a warehousePending item to an existing product, or mark it as a brand-new product.
router.patch('/:id/items/:itemId/link', staffOnly, async (req, res) => {
  try {
    const { existingProductId, markAsNew, keepNewPhoto } = req.body || {};
    const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id });
    if (!item) return res.status(404).json({ error: 'Item not found' });

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
  } catch (err) {
    console.error('[receipts.items.link] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to link item' });
  }
});

// ── HISTORY / AUDIT LOG ────────────────────────────────────────────────────

// GET all logs for a receipt (lazy — only called when user explicitly opens history)
router.get('/:id/logs', staffOnly, async (req, res) => {
  try {
    const logs = await ReceiptItemLog.find({ receiptId: req.params.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch logs' });
  }
});

// POST a move_to_block action from the frontend (addToBlock lives in blocks route, not here)
router.post('/:id/items/:itemId/log', staffOnly, async (req, res) => {
  try {
    const { action, blockId, itemName } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action is required' });

    await ReceiptItemLog.create({
      receiptId: req.params.id,
      itemId: req.params.itemId,
      itemName: itemName || '',
      action,
      actor: getActor(req),
      meta: blockId ? { blockId } : {},
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to log action' });
  }
});

module.exports = router;
