require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { MongoClient } = require('mongoose').mongo;
const client = new MongoClient(process.env.MONGODB_URI);
client.connect().then(async () => {
  const db = client.db();
  const groups = await db.collection('deliverygroups').find({}).toArray();
  const shops = await db.collection('shops').find({ deliveryGroupId: { $ne: '' } }).limit(5).toArray();
  const users = await db.collection('users').find({ role: 'seller' }).limit(5).toArray();
  console.log('Groups:');
  groups.forEach(g => console.log('  id:', g._id.constructor.name, String(g._id), '|', g.name));
  console.log('\nShops with deliveryGroupId:');
  shops.forEach(s => console.log('  name:', s.name, '| deliveryGroupId type:', typeof s.deliveryGroupId, '| value:', JSON.stringify(s.deliveryGroupId)));
  console.log('\nUsers sellers:');
  users.forEach(u => console.log('  name:', u.firstName, '| shopId type:', typeof u.shopId, '| value:', JSON.stringify(u.shopId)));
  await client.close();
}).catch(e => console.error(e.message));
