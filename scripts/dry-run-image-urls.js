/**
 * Dry-run: show what migrate-image-urls.js would change, without writing anything.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
const OLD = '/api/products/images/';

async function run() {
  console.log('Connecting to:', MONGODB_URI.replace(/:\/\/[^@]+@/, '://***@'));
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  const products = db.collection('products');
  const docs = await products.find({
    $or: [
      { imageUrls: { $elemMatch: { $regex: '^/api/products/images/' } } },
      { originalImageUrl: { $regex: '^/api/products/images/' } },
      { localImageUrl: { $regex: '^/api/products/images/' } },
    ],
  }).toArray();

  console.log('\n=== PRODUCTS to update:', docs.length, '===');
  docs.slice(0, 10).forEach((d) => {
    console.log('  _id:', String(d._id), '| imageUrls[0]:', d.imageUrls?.[0]);
  });
  if (docs.length > 10) console.log(`  ... and ${docs.length - 10} more`);

  const items = db.collection('receiptitems');
  const itemCount = await items.countDocuments({ photoUrl: { $regex: '^/api/products/images/' } });
  console.log('\n=== RECEIPTITEMS to update:', itemCount, '===');

  await mongoose.disconnect();
  console.log('\nDry-run complete. No changes made.');
}

run().catch((err) => { console.error(err); process.exit(1); });
