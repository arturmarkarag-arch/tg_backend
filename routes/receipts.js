const express = require('express');
const crypto = require('crypto');
const Busboy = require('busboy');
const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { shiftUp } = require('../utils/shiftOrderNumbers');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const Receipt = require('../models/Receipt');
const ReceiptItem = require('../models/ReceiptItem');
const Product = require('../models/Product');
const User = require('../models/User');
const Order = require('../models/Order');
const { getIO } = require('../socket');

const staffOnly = requireTelegramRoles(['admin', 'warehouse']);

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

    if (!req.is('multipart/form-data')) {
      return res.status(400).json({ error: 'multipart/form-data is required' });
    }

    const parsed = await parseMultipart(req);
    const file = parsed.files?.[0];
    const existingProductId = parsed.fields.existingProductId ? String(parsed.fields.existingProductId).trim() : null;
    const deliveryGroupIds = parsed.fields.deliveryGroupIds ? JSON.parse(parsed.fields.deliveryGroupIds) : [];
    const qtyPerShop = parsed.fields.qtyPerShop ? Number(parsed.fields.qtyPerShop) : 0;

    if (!file && !existingProductId) {
      return res.status(400).json({ error: 'Photo file is required when this is a new product' });
    }

    const totalQty = Number(parsed.fields.totalQty ?? 0);
    const transitQty = Number(parsed.fields.transitQty ?? 0);
    const shelfQty = totalQty - transitQty;

    if (totalQty < 1 || Number.isNaN(totalQty)) {
      return res.status(400).json({ error: 'totalQty must be a number greater than 0' });
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
      photoName: photoName || 'photo.jpg',
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
    });

    await receiptItem.save();

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
    res.json(items);
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
    const parsed = await parseMultipart(req);
    const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const totalQty = parsed.fields.totalQty !== undefined ? Number(parsed.fields.totalQty) : item.totalQty;
    const transitQty = parsed.fields.transitQty !== undefined ? Number(parsed.fields.transitQty) : item.transitQty;
    const shelfQty = totalQty - transitQty;

    if (totalQty < 1 || Number.isNaN(totalQty)) return res.status(400).json({ error: 'Invalid totalQty' });
    if (shelfQty < 0) return res.status(400).json({ error: 'transitQty cannot exceed totalQty' });

    const existingProductId = parsed.fields.existingProductId ? String(parsed.fields.existingProductId).trim() : null;
    const deliveryGroupIds = parsed.fields.deliveryGroupIds ? JSON.parse(parsed.fields.deliveryGroupIds) : [];
    const qtyPerShop = parsed.fields.qtyPerShop ? Number(parsed.fields.qtyPerShop) : 0;
    item.totalQty = totalQty;
    item.transitQty = transitQty;
    item.shelfQty = shelfQty;
    item.deliveryGroupIds = Array.isArray(deliveryGroupIds) ? deliveryGroupIds : [];
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
  try {
    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    if (receipt.status === 'completed') {
      return res.status(400).json({ error: 'Receipt already completed' });
    }

    const items = await ReceiptItem.find({ receiptId: receipt._id });
    if (!items.length) {
      return res.status(400).json({ error: 'Receipt has no items' });
    }

    const invalidItem = items.find((item) => !item.name || item.price === null || item.price <= 0);
    if (invalidItem) {
      return res.status(400).json({ error: 'Не всі товари повністю описані' });
    }

    const createdProducts = [];
    for (const item of items) {
      let currentProduct;

      // 1. Оновлюємо або створюємо товар
      if (item.existingProductId) {
        currentProduct = await Product.findById(item.existingProductId);
        if (currentProduct) {
          currentProduct.quantity += item.shelfQty;
          if (item.price !== null) currentProduct.price = item.price;
          if (item.qtyPerPackage) currentProduct.quantityPerPackage = item.qtyPerPackage;
          await currentProduct.save();
          item.createdProductId = currentProduct._id;
          await item.save();
        }
      }

      if (!currentProduct) {
        await shiftUp({ orderNumber: { $gte: 1 } });

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

        await currentProduct.save();
        item.createdProductId = currentProduct._id;
        await item.save();
      }

      createdProducts.push(currentProduct);

      // 2. ЛОГІКА ТРАНЗИТУ (спільна для нових та існуючих товарів)
      if (item.transitQty > 0 && item.deliveryGroupIds && item.deliveryGroupIds.length > 0) {
        const targetUsers = await User.find({
          deliveryGroupId: { $in: item.deliveryGroupIds },
          role: 'seller',
        }).lean();

        if (targetUsers.length > 0) {
          const shuffledUsers = targetUsers.sort(() => 0.5 - Math.random());
          const qtyPerShop = item.qtyPerShop > 0 ? item.qtyPerShop : Math.floor(item.transitQty / targetUsers.length);

          if (qtyPerShop > 0) {
            let remainingTransit = item.transitQty;

            for (const user of shuffledUsers) {
              if (remainingTransit >= qtyPerShop) {
                const directOrder = new Order({
                  buyerTelegramId: user.telegramId,
                  orderType: 'direct_allocation',
                  receiptId: receipt._id,
                  status: 'confirmed',
                  items: [{
                    productId: currentProduct._id,
                    name: currentProduct.brand || currentProduct.name || item.name,
                    price: currentProduct.price,
                    quantity: qtyPerShop,
                  }],
                  totalPrice: currentProduct.price * qtyPerShop,
                  idempotencyKey: `direct_alloc_${receipt._id}_${currentProduct._id}_${user.telegramId}`,
                });
                await directOrder.save();
                remainingTransit -= qtyPerShop;
              } else {
                break;
              }
            }

            if (remainingTransit > 0) {
              currentProduct.quantity += remainingTransit;
              await currentProduct.save();
            }
          }
        }
      }
    }

    receipt.status = 'completed';
    receipt.completedAt = new Date();
    await receipt.save();

    res.json({ receipt, createdProductsCount: createdProducts.length });
  } catch (err) {
    console.error('[receipts.commit] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to commit receipt' });
  }
});

module.exports = router;
