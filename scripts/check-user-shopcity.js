require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const u = await db.collection('users').findOne({ role: 'seller', shopId: { $exists: true, $ne: null } });
  console.log('shopId:', u.shopId);
  console.log('shopCity:', JSON.stringify(u.shopCity));
  console.log('shopName:', JSON.stringify(u.shopName));

  // Count how many sellers have non-empty shopCity
  const withCity = await db.collection('users').countDocuments({ role: 'seller', shopCity: { $nin: [null, ''] } });
  const total = await db.collection('users').countDocuments({ role: 'seller' });
  console.log(`Sellers with shopCity: ${withCity} / ${total}`);

  await mongoose.disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
