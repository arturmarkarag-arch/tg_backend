require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const sellers = await db.collection('users').find({
    role: 'seller', shopId: { $exists: true, $ne: null }
  }).limit(10).toArray();

  console.log('Sample sellers with shopId:');
  sellers.forEach(u => console.log(
    u.telegramId, '|',
    (u.firstName || '(no name)'), (u.lastName || ''),
    '| shopId:', String(u.shopId)
  ));

  // Check sellers WITHOUT name
  const noName = await db.collection('users').countDocuments({
    role: 'seller', $or: [{ firstName: { $in: [null, ''] } }, { firstName: { $exists: false } }]
  });
  const total = await db.collection('users').countDocuments({ role: 'seller' });
  console.log(`\nTotal sellers: ${total} | Without firstName: ${noName}`);

  await mongoose.disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
