const mongoose = require('mongoose');

const URI = 'mongodb+srv://arturmarkarag_db_user:7VKbO5R8Se4zrNo5@cluster0.yvgxmyl.mongodb.net/?appName=Cluster0';

async function main() {
  await mongoose.connect(URI);
  const db = mongoose.connection.db;

  const GROUP_ID = '69def91c35362e32bb02247e';

  // Orders with this deliveryGroupId in buyerSnapshot
  const ordersByStatus = await db.collection('orders').aggregate([
    { $match: { 'buyerSnapshot.deliveryGroupId': GROUP_ID } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  console.log('Orders for "Доставка Вівторок" by status:', JSON.stringify(ordersByStatus, null, 2));

  const total = await db.collection('orders').countDocuments({ 'buyerSnapshot.deliveryGroupId': GROUP_ID });
  console.log('Total orders:', total);

  // Show a few samples with status "fulfilled" or similar
  const samples = await db.collection('orders').find(
    { 'buyerSnapshot.deliveryGroupId': GROUP_ID },
    { projection: { status: 1, orderNumber: 1, createdAt: 1, updatedAt: 1, shopId: 1 } }
  ).limit(10).toArray();
  console.log('\nSample orders:', JSON.stringify(samples, null, 2));

  // Also check pickingtasks
  const pickingByStatus = await db.collection('pickingtasks').aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  console.log('\nPickingTasks by status:', JSON.stringify(pickingByStatus, null, 2));

  const samplePicking = await db.collection('pickingtasks').findOne({});
  if (samplePicking) {
    const safe = Object.fromEntries(
      Object.entries(samplePicking).map(([k,v]) =>
        Array.isArray(v) ? [k, `[${v.length} items]`] : [k, v]
      )
    );
    console.log('\nSample pickingtask:', JSON.stringify(safe, null, 2));
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
