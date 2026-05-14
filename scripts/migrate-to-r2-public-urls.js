/**
 * One-time migration: replace all /api/v1/products/images/ and /api/products/images/
 * proxy URLs with direct R2 public URLs.
 *
 * Run: node server/scripts/migrate-to-r2-public-urls.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tg_manager';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

if (!R2_PUBLIC_URL) {
  console.error('R2_PUBLIC_URL is not set in .env');
  process.exit(1);
}

const OLD_PATTERNS = [
  { prefix: '/api/v1/products/images/', folder: 'products' },
  { prefix: '/api/products/images/',    folder: 'products' },
  { prefix: '/api/v1/products/originals/', folder: 'originals' },
];

function migrateUrl(url) {
  if (typeof url !== 'string') return url;
  for (const { prefix, folder } of OLD_PATTERNS) {
    if (url.startsWith(prefix)) {
      const filename = url.slice(prefix.length);
      return `${R2_PUBLIC_URL}/${folder}/${filename}`;
    }
  }
  return url;
}

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB:', MONGODB_URI);
  console.log('R2_PUBLIC_URL:', R2_PUBLIC_URL);

  const db = mongoose.connection.db;

  // --- Products ---
  const products = db.collection('products');
  const allProducts = await products.find({
    $or: OLD_PATTERNS.map(({ prefix }) => ({
      $or: [
        { imageUrls: { $elemMatch: { $regex: `^${prefix.replace(/\//g, '\\/')}` } } },
        { originalImageUrl: { $regex: `^${prefix.replace(/\//g, '\\/')}` } },
        { localImageUrl:    { $regex: `^${prefix.replace(/\//g, '\\/')}` } },
      ],
    })).flat(),
  }).toArray();

  console.log(`Found ${allProducts.length} products to migrate`);
  let productCount = 0;

  for (const product of allProducts) {
    const update = {};

    if (Array.isArray(product.imageUrls)) {
      const newUrls = product.imageUrls.map(migrateUrl);
      if (JSON.stringify(newUrls) !== JSON.stringify(product.imageUrls)) {
        update.imageUrls = newUrls;
      }
    }
    const newOriginal = migrateUrl(product.originalImageUrl);
    if (newOriginal !== product.originalImageUrl) update.originalImageUrl = newOriginal;

    const newLocal = migrateUrl(product.localImageUrl);
    if (newLocal !== product.localImageUrl) update.localImageUrl = newLocal;

    if (Object.keys(update).length > 0) {
      await products.updateOne({ _id: product._id }, { $set: update });
      productCount++;
    }
  }
  console.log(`Products migrated: ${productCount}`);

  // --- ReceiptItems ---
  const receiptItems = db.collection('receiptitems');
  let receiptCount = 0;
  for (const { prefix, folder } of OLD_PATTERNS) {
    const result = await receiptItems.updateMany(
      { photoUrl: { $regex: `^${prefix.replace(/\//g, '\\/')}` } },
      [{ $set: { photoUrl: { $replaceAll: { input: '$photoUrl', find: prefix, replacement: `${R2_PUBLIC_URL}/${folder}/` } } } }]
    );
    receiptCount += result.modifiedCount;
  }
  console.log(`ReceiptItems migrated: ${receiptCount}`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
