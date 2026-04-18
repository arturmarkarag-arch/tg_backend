require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Product = require('../models/Product');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const r = await Product.updateMany(
    { telegramFileId: { $exists: true } },
    { $unset: { telegramFileId: 1 } }
  );
  console.log('Cleared telegramFileId from', r.modifiedCount, 'products');
  await mongoose.disconnect();
})();
