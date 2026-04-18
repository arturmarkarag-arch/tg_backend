require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Product = require('../models/Product');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const p = await Product.findOne({ status: 'active', price: 0 })
    .select('orderNumber price imageUrls quantityPerPackage')
    .lean();
  console.log('Product with price=0:', p ? `#${p.orderNumber} imgs=${(p.imageUrls||[]).length}` : 'NONE');

  const e = await Product.findOne({ status: 'active', imageUrls: { $size: 0 } })
    .select('orderNumber price imageUrls')
    .lean();
  console.log('Product with empty imageUrls:', e ? `#${e.orderNumber} price=${e.price}` : 'NONE');

  await mongoose.disconnect();
})();
