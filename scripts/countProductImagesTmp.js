const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '..', '.env') });
const Product = require('../models/Product');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const total = await Product.countDocuments({});
  const withImageUrls = await Product.countDocuments({ imageUrls: { $exists: true, $ne: [] } });
  const withLocalImage = await Product.countDocuments({ localImageUrl: { $exists: true, $ne: '' } });
  const withTelegramFileId = await Product.countDocuments({ telegramFileId: { $exists: true, $ne: '' } });
  console.log('TOTAL', total);
  console.log('WITH_IMAGEURLS', withImageUrls);
  console.log('WITH_LOCALIMAGEURL', withLocalImage);
  console.log('WITH_TELEGRAM_FILEID', withTelegramFileId);
  await mongoose.disconnect();
})();
