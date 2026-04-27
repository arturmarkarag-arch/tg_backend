require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Block = require('../models/Block');

function hasImageFilter() {
  return {
    $or: [
      { imageUrls: { $exists: true, $ne: [] } },
      { localImageUrl: { $exists: true, $ne: '' } },
      { telegramFileId: { $exists: true, $ne: '' } },
      { telegramMessageIds: { $exists: true, $ne: [] } },
    ],
  };
}

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const total = await Product.countDocuments({});
  const withImage = await Product.countDocuments(hasImageFilter());
  const withoutImage = total - withImage;

  console.log('Total products:', total);
  console.log('Products with photo data:', withImage);
  console.log('Products without photo data:', withoutImage);

  const sample = await Product.find({
    $nor: [
      { imageUrls: { $exists: true, $ne: [] } },
      { localImageUrl: { $exists: true, $ne: '' } },
      { telegramFileId: { $exists: true, $ne: '' } },
      { telegramMessageIds: { $exists: true, $ne: [] } },
    ],
  })
    .limit(20)
    .select('_id orderNumber status imageUrls localImageUrl telegramFileId telegramMessageIds')
    .lean();

  if (sample.length) {
    console.log('Sample products without photos:');
    sample.forEach((product) => {
      console.log(`- ${product._id} #${product.orderNumber || 'na'} status=${product.status} imageUrls=${(product.imageUrls || []).length} localImageUrl=${Boolean(product.localImageUrl)} telegramFileId=${Boolean(product.telegramFileId)} telegramMessageIds=${(product.telegramMessageIds || []).length}`);
    });
  } else {
    console.log('No sample products without photos found.');
  }

  if (withoutImage > 0 && process.argv.includes('--fix')) {
    const productsToDelete = await Product.find({
      $nor: [
        { imageUrls: { $exists: true, $ne: [] } },
        { localImageUrl: { $exists: true, $ne: '' } },
        { telegramFileId: { $exists: true, $ne: '' } },
        { telegramMessageIds: { $exists: true, $ne: [] } },
      ],
    }).select('_id');

    const ids = productsToDelete.map((p) => p._id);
    if (ids.length) {
      const deleteResult = await Product.deleteMany({ _id: { $in: ids } });
      await Block.updateMany(
        { productIds: { $in: ids } },
        { $pull: { productIds: { $in: ids } }, $inc: { version: 1 } }
      );
      console.log(`Deleted ${deleteResult.deletedCount} products without photos and removed references from blocks.`);
    }
  } else if (withoutImage > 0) {
    console.log('Run with --fix to delete those products and clean block references.');
  }

  await mongoose.disconnect();
  process.exit(0);
})();
