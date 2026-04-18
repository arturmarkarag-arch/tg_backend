const express = require('express');
const { Readable } = require('stream');
const crypto = require('crypto');
const Busboy = require('busboy');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { shiftUp, shiftDown } = require('../utils/shiftOrderNumbers');
const Product = require('../models/Product');

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

const router = express.Router();

router.get('/images/:filename', async (req, res) => {
  try {
    const result = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: `products/${req.params.filename}`,
    }));
    res.setHeader('Content-Type', result.ContentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const nodeStream = result.Body instanceof Readable ? result.Body : Readable.fromWeb(result.Body);
    nodeStream.pipe(res);
  } catch (err) {
    console.error('Image proxy error:', err.message);
    res.status(404).json({ error: 'Image not found' });
  }
});

router.get('/', async (req, res) => {
  const products = await Product.find({ status: { $ne: 'archived' } }).sort({ orderNumber: 1, createdAt: -1 });
  res.json(products);
});

router.get('/pending', async (req, res) => {
  const products = await Product.find({ status: 'pending' }).sort({ orderNumber: 1 });
  res.json(products);
});

router.patch('/reorder', async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'Order must be an array of product ids' });
  }

  const bulkOps = order.map((id, index) => ({
    updateOne: {
      filter: { _id: id },
      update: { positionOrder: index },
    },
  }));

  await Product.bulkWrite(bulkOps);
  res.json({ message: 'Order updated' });
});

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

router.get('/:id', async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

router.post('/', async (req, res) => {
  let fields, files = [];

  if (req.is('multipart/form-data')) {
    const parsed = await parseMultipart(req);
    fields = parsed.fields;
    files = parsed.files;
  } else {
    fields = req.body;
  }

  const { orderNumber, name, description, category, brand, model, deliveryGroup, warehouse, status } = fields;
  const price = Number(fields.price ?? 0);
  const quantity = Number(fields.quantity ?? 0);
  const parsedOrderNumber = Number(orderNumber ?? 0);

  if (!name || price <= 0 || quantity < 0 || parsedOrderNumber <= 0) {
    return res.status(400).json({ error: "Порядковий номер, назва, ціна та кількість є обов'язковими" });
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
    name,
    description: description || '',
    price,
    quantity,
    warehouse: warehouse || '',
    category: category || '',
    brand: brand || '',
    model: model || '',
    deliveryGroup: deliveryGroup || '',
    status: status || 'pending',
    imageUrls,
    imageNames,
  });

  await product.save();
  res.status(201).json(product);
});

router.patch('/:id', async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  let fields = req.body;
  let files = [];

  if (req.is('multipart/form-data')) {
    const parsed = await parseMultipart(req);
    fields = parsed.fields;
    files = parsed.files;
  }

  const { orderNumber, name, description, category, brand, model, deliveryGroup, warehouse, status, price, quantity } = fields;
  const parsedOrderNumber = orderNumber !== undefined ? Number(orderNumber) : product.orderNumber;

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
  if (name !== undefined) product.name = name;
  if (description !== undefined) product.description = description;
  if (category !== undefined) product.category = category;
  if (brand !== undefined) product.brand = brand;
  if (model !== undefined) product.model = model;
  if (deliveryGroup !== undefined) product.deliveryGroup = deliveryGroup;
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

router.delete('/:id', async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // Soft-delete: move to archive instead of permanent removal
  product.status = 'archived';
  product.archivedAt = new Date();
  product.originalOrderNumber = product.orderNumber;
  const oldOrder = product.orderNumber;
  product.orderNumber = 0; // archived products don't occupy a position
  await product.save();

  // Shift remaining active/pending products down
  await shiftDown({ orderNumber: { $gt: oldOrder }, status: { $ne: 'archived' } });

  res.json({ message: 'Product archived' });
});

module.exports = router;
