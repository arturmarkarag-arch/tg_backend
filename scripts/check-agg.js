require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  console.log('=== DeliveryGroups ===');
  const groups = await db.collection('deliverygroups').find({}).toArray();
  groups.forEach(g => console.log(' ', String(g._id), '|', g.name));

  console.log('\n=== shopCount per deliveryGroupId ===');
  const shopCounts = await db.collection('shops').aggregate([
    { $match: { deliveryGroupId: { $ne: '' }, isActive: true } },
    { $group: { _id: '$deliveryGroupId', count: { $sum: 1 } } },
  ]).toArray();
  shopCounts.forEach(r => console.log(' ', r._id, '→', r.count));

  console.log('\n=== sellerCount via shopId → deliveryGroupId ===');
  const sellerCounts = await db.collection('users').aggregate([
    { $match: { role: 'seller', shopId: { $ne: null, $exists: true } } },
    { $lookup: { from: 'shops', localField: 'shopId', foreignField: '_id', as: 'shop' } },
    { $unwind: '$shop' },
    { $group: { _id: '$shop.deliveryGroupId', count: { $sum: 1 } } },
  ]).toArray();
  sellerCounts.forEach(r => console.log(' ', JSON.stringify(r._id), '→', r.count));

  console.log('\n=== Sellers without shopId ===');
  const noShop = await db.collection('users').countDocuments({ role: 'seller', $or: [{ shopId: null }, { shopId: { $exists: false } }] });
  const withShop = await db.collection('users').countDocuments({ role: 'seller', shopId: { $ne: null, $exists: true } });
  console.log(' sellers without shopId:', noShop);
  console.log(' sellers with shopId:', withShop);

  await mongoose.disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
