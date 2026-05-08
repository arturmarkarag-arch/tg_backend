// Видаляє з тест-бази групи доставки, які не мають магазинів
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const groups = await db.collection('deliverygroups').find({}).toArray();
  const shopsRaw = await db.collection('shops').find({}).project({ deliveryGroupId: 1 }).toArray();
  const usedGroupIds = new Set(shopsRaw.map(s => s.deliveryGroupId).filter(Boolean));

  console.log('Groups:');
  const toDelete = [];
  groups.forEach(g => {
    const hasShops = usedGroupIds.has(String(g._id));
    const mark = hasShops ? '✅ keep' : '❌ no shops';
    console.log(' ', String(g._id), '|', g.name, '|', mark);
    if (!hasShops) toDelete.push(g._id);
  });

  if (toDelete.length === 0) {
    console.log('\nAll groups have shops, nothing to delete.');
  } else if (!process.argv.includes('--run')) {
    console.log(`\nDRY-RUN: would delete ${toDelete.length} groups. Run with --run.`);
  } else {
    const r = await db.collection('deliverygroups').deleteMany({ _id: { $in: toDelete } });
    console.log(`\nDeleted ${r.deletedCount} empty groups.`);
  }
  await mongoose.disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
