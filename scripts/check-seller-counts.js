require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Check actual type of shopId in users
  const u = await db.collection('users').findOne({ role: 'seller', shopId: { $exists: true, $ne: null } });
  if (u) console.log('User shopId type:', u.shopId?.constructor?.name, '| value:', String(u.shopId));

  // Get shops as ObjectIds
  const shops = await db.collection('shops').find({ isActive: true }).limit(5).toArray();
  const shopIds = shops.map((s) => s._id);
  console.log('Shop _id type:', shopIds[0]?.constructor?.name);

  // Try with ObjectId
  const counts = await db.collection('users').aggregate([
    { $match: { role: 'seller', shopId: { $in: shopIds } } },
    { $group: { _id: '$shopId', count: { $sum: 1 } } },
  ]).toArray();
  console.log('Counts with ObjectId match:', counts.slice(0, 5));

  // Total sellers with shopId
  const total = await db.collection('users').countDocuments({ role: 'seller', shopId: { $exists: true, $ne: null } });
  console.log('Total sellers with shopId:', total);
  await mongoose.disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
