/**
 * migrate-cities.js
 * 1. Читає всі унікальні назви міст з колекції shops (trim)
 * 2. Створює City документи (upsert by name)
 * 3. Оновлює кожен Shop: cityId = відповідний City._id, city = City.name (canonical)
 * 4. Оновлює User.shopCity = відповідне City.name (canonical trim)
 *
 * Usage:
 *   node scripts/migrate-cities.js          ← dry-run
 *   node scripts/migrate-cities.js --run    ← write
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');

const WRITE = process.argv.includes('--run');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log(WRITE ? '✍️  WRITE mode' : '🔍 DRY-RUN mode (use --run to write)');
  console.log('DB:', process.env.MONGODB_URI.split('@')[1].split('/')[0]);

  // 1. Collect distinct city names from shops
  const rawCities = await db.collection('shops').distinct('city');
  const canonicalNames = [...new Set(rawCities.map((c) => String(c).trim()).filter(Boolean))].sort();
  console.log(`\nFound ${canonicalNames.length} distinct city names in shops:`);
  canonicalNames.forEach((c) => console.log(' ', c));

  if (!WRITE) {
    console.log('\nDRY-RUN: would create City docs + update shops + normalize users.');
    console.log('Run with --run to apply.');
    await mongoose.disconnect();
    return;
  }

  // 2. Upsert City docs
  const cityMap = {}; // name → _id
  for (const name of canonicalNames) {
    const doc = await db.collection('cities').findOneAndUpdate(
      { name },
      { $setOnInsert: { name, country: 'PL', createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );
    const cityId = doc.value?._id ?? doc._id;
    cityMap[name] = cityId;
    console.log(`City: ${name} → ${cityId}`);
  }

  // 3. Update each shop: set cityId and canonical city name
  const shops = await db.collection('shops').find({}).toArray();
  let shopsUpdated = 0;
  for (const shop of shops) {
    const canonical = String(shop.city || '').trim();
    const cityId = cityMap[canonical];
    if (!cityId) {
      console.warn(`  ⚠️  Shop "${shop.name}" has unknown city "${shop.city}" — skipping cityId`);
      continue;
    }
    await db.collection('shops').updateOne(
      { _id: shop._id },
      { $set: { cityId, city: canonical } }
    );
    shopsUpdated++;
  }
  console.log(`\nUpdated ${shopsUpdated} / ${shops.length} shops with cityId`);

  // 4. Normalize User.shopCity (trim + canonical)
  const users = await db.collection('users').find({ role: 'seller', shopCity: { $exists: true, $ne: null } }).toArray();
  let usersUpdated = 0;
  for (const user of users) {
    const trimmed = String(user.shopCity || '').trim();
    // Find canonical city name (case-insensitive match if needed)
    const canonical = canonicalNames.find((c) => c.toLowerCase() === trimmed.toLowerCase()) || trimmed;
    if (canonical !== user.shopCity) {
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { shopCity: canonical } }
      );
      usersUpdated++;
    }
  }
  console.log(`Updated ${usersUpdated} user shopCity values (normalized whitespace/case)`);

  // Also trim shopName in users
  const usersWithName = await db.collection('users').find({ role: 'seller', shopName: { $exists: true, $ne: '' } }).toArray();
  let namesFixed = 0;
  for (const user of usersWithName) {
    const trimmed = String(user.shopName || '').trim();
    if (trimmed !== user.shopName) {
      await db.collection('users').updateOne({ _id: user._id }, { $set: { shopName: trimmed } });
      namesFixed++;
    }
  }
  console.log(`Trimmed shopName for ${namesFixed} users`);

  console.log('\n✅ Migration complete.');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
