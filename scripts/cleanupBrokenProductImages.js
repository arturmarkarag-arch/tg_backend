require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const Product = require('../models/Product');

const r2Client = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

function parseImageFilename(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url, 'http://example.com');
    const parts = parsed.pathname.split('/').filter(Boolean);
    const filename = parts.length ? parts[parts.length - 1] : null;
    return filename || null;
  } catch {
    const parts = url.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  }
}

async function headImage(filename) {
  if (!filename) return false;
  try {
    await r2Client.send(new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: `products/${filename}`,
    }));
    return true;
  } catch (err) {
    return false;
  }
}

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set in .env');
    process.exit(1);
  }
  if (!process.env.R2_BUCKET_NAME || !process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.error('R2 credentials are not fully configured in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const products = await Product.find({ imageUrls: { $exists: true, $ne: [] } }).lean();
  let totalImages = 0;
  let goodImages = 0;
  let brokenImages = 0;
  let productsWithBroken = 0;
  const brokenRecords = [];

  for (const product of products) {
    const imageUrls = Array.isArray(product.imageUrls) ? product.imageUrls : [];
    const imageNames = Array.isArray(product.imageNames) ? product.imageNames : [];
    let productBroken = 0;

    for (let index = 0; index < imageUrls.length; index += 1) {
      const url = imageUrls[index];
      const filename = parseImageFilename(url);
      totalImages += 1;
      const exists = await headImage(filename);
      if (exists) {
        goodImages += 1;
      } else {
        brokenImages += 1;
        productBroken += 1;
        brokenRecords.push({
          productId: product._id.toString(),
          orderNumber: product.orderNumber,
          url,
          filename,
          index,
          imageName: imageNames[index] || null,
        });
      }
    }

    if (productBroken > 0) {
      productsWithBroken += 1;
    }
  }

  console.log('Broken image scan completed');
  console.log(`Products checked: ${products.length}`);
  console.log(`Total images found: ${totalImages}`);
  console.log(`Good images: ${goodImages}`);
  console.log(`Broken images: ${brokenImages}`);
  console.log(`Products with at least one broken image: ${productsWithBroken}`);
  console.log('Sample broken entries:');
  brokenRecords.slice(0, 20).forEach((item) => {
    console.log(`- product ${item.productId} #${item.orderNumber} url=${item.url} filename=${item.filename}`);
  });

  const fix = process.argv.includes('--fix');
  if (fix) {
    console.log('Fix mode enabled: removing broken image URLs from products');
    for (const record of brokenRecords) {
      const product = await Product.findById(record.productId);
      if (!product) continue;
      const urls = Array.isArray(product.imageUrls) ? product.imageUrls : [];
      const names = Array.isArray(product.imageNames) ? product.imageNames : [];
      if (record.index >= 0 && record.index < urls.length) {
        urls.splice(record.index, 1);
        names.splice(record.index, 1);
      }
      product.imageUrls = urls;
      product.imageNames = names;
      await product.save();
      console.log(`Cleaned product ${record.productId} removed broken image ${record.url}`);
    }
    console.log('Fix complete');
  } else {
    console.log('Run with --fix to remove broken image references from products');
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Cleanup script failed:', err);
  process.exit(1);
});
