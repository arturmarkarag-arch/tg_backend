/**
 * One-time migration: replace /api/products/images/ → /api/v1/products/images/
 * in imageUrls, originalImageUrl, localImageUrl fields of Product collection,
 * and photoUrl in ReceiptItem collection.
 *
 * Run: node server/scripts/migrate-image-urls.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tg_manager';
const OLD = '/api/products/images/';
const NEW = '/api/v1/products/images/';

function replaceUrl(url) {
  if (typeof url === 'string' && url.startsWith(OLD)) {
    return NEW + url.slice(OLD.length);
  }
  return url;
}

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB:', MONGODB_URI);

  const db = mongoose.connection.db;

  // --- Products ---
  const products = db.collection('products');
  const allProducts = await products.find({
    $or: [
      { imageUrls: { $elemMatch: { $regex: '^/api/products/images/' } } },
      { originalImageUrl: { $regex: '^/api/products/images/' } },
      { localImageUrl: { $regex: '^/api/products/images/' } },
    ],
  }).toArray();

  console.log(`Found ${allProducts.length} products to migrate`);

  for (const product of allProducts) {
    const update = {};

    if (Array.isArray(product.imageUrls)) {
      const newUrls = product.imageUrls.map(replaceUrl);
      if (JSON.stringify(newUrls) !== JSON.stringify(product.imageUrls)) {
        update.imageUrls = newUrls;
      }
    }
    if (product.originalImageUrl?.startsWith(OLD)) {
      update.originalImageUrl = replaceUrl(product.originalImageUrl);
    }
    if (product.localImageUrl?.startsWith(OLD)) {
      update.localImageUrl = replaceUrl(product.localImageUrl);
    }

    if (Object.keys(update).length > 0) {
      await products.updateOne({ _id: product._id }, { $set: update });
    }
  }
  console.log('Products migrated.');

  // --- ReceiptItems ---
  const receiptItems = db.collection('receiptitems');
  const result = await receiptItems.updateMany(
    { photoUrl: { $regex: '^/api/products/images/' } },
    [{ $set: { photoUrl: { $replaceAll: { input: '$photoUrl', find: OLD, replacement: NEW } } } }]
  );
  console.log(`ReceiptItems migrated: ${result.modifiedCount} documents updated.`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
