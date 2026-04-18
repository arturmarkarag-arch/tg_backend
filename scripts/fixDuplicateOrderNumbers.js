/**
 * One-time script: fix duplicate orderNumbers in products.
 * Sorts all products by (orderNumber ASC, createdAt ASC) and reassigns
 * sequential orderNumbers 1, 2, 3, ... preserving relative order.
 *
 * Run: node scripts/fixDuplicateOrderNumbers.js
 */
const dotenv = require('dotenv');
dotenv.config({ path: '../.env' });

const mongoose = require('mongoose');
const Product = require('../models/Product');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tg_manager';

async function fix() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const products = await Product.find().sort({ orderNumber: 1, createdAt: 1 });
  console.log(`Total products found: ${products.length}`);

  for (let i = 0; i < products.length; i++) {
    const newNumber = i + 1;
    if (products[i].orderNumber !== newNumber) {
      console.log(`  Product "${products[i].name}" (${products[i]._id}): ${products[i].orderNumber} → ${newNumber}`);
      // Use updateOne to bypass any schema hooks and directly set the number
      await Product.updateOne({ _id: products[i]._id }, { $set: { orderNumber: newNumber } });
    }
  }

  console.log('Done. All orderNumbers are now unique and sequential.');
  await mongoose.disconnect();
}

fix().catch((err) => {
  console.error(err);
  process.exit(1);
});
