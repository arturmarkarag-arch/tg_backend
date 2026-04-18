require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Product = require('../models/Product');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const price0 = await Product.countDocuments({ status: 'active', price: 0 });
  console.log('Active products with price=0:', price0);

  const noImgArr = await Product.countDocuments({ status: 'active', imageUrls: { $size: 0 } });
  const noImgNull = await Product.countDocuments({ status: 'active', imageUrls: { $exists: false } });
  console.log('Active products with empty imageUrls:', noImgArr, '/ missing imageUrls:', noImgNull);

  const first5 = await Product.find({ status: 'active' })
    .sort({ orderNumber: 1 })
    .limit(5)
    .select('orderNumber price quantityPerPackage imageUrls')
    .lean();
  console.log('First 5 active products:');
  first5.forEach(p => console.log(
    `  #${p.orderNumber} price=${p.price} qty=${p.quantityPerPackage} imgs=${(p.imageUrls||[]).length} url=${(p.imageUrls||[])[0] || 'NONE'}`
  ));

  await mongoose.disconnect();
})();
