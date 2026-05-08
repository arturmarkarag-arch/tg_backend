/**
 * seed-shops.js
 * Читає shops-export-normalized.json і:
 *   1. Створює документи в колекції Shop (якщо ще не існують)
 *   2. Оновлює AppSettings shops.cities
 *   3. Зв'язує кожного продавця: User.shopId = Shop._id
 *
 * Режими:
 *   node scripts/seed-shops.js            -- dry-run (тільки показує що буде)
 *   node scripts/seed-shops.js --run      -- реальний запис
 *   node scripts/seed-shops.js --input shops-export-normalized.json
 *
 * Ідемпотентний: повторний запуск не створює дублікатів (пошук по name+city)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tg_manager';

const dryRun = !process.argv.includes('--run');
const inputArg = process.argv.indexOf('--input');
const inputFile = inputArg !== -1
  ? path.resolve(process.argv[inputArg + 1])
  : path.join(__dirname, 'shops-export-normalized.json');

async function run() {
  if (!fs.existsSync(inputFile)) {
    console.error(`❌ Файл не знайдено: ${inputFile}`);
    console.error('   Спочатку запусти: node scripts/normalize-cities.js');
    process.exit(1);
  }

  const records = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  console.log(`📂 Завантажено ${records.length} записів з ${inputFile}`);
  console.log(`🔌 Підключаємось до: ${MONGODB_URI}`);

  await mongoose.connect(MONGODB_URI);
  console.log('✅ Підключено\n');

  const db = mongoose.connection.db;
  const shopsCol      = db.collection('shops');
  const usersCol      = db.collection('users');
  const appSettingsCol = db.collection('appsettings');

  // ─── 1. Збираємо унікальні магазини з файлу ────────────────────────────────
  // Ключ: "name|city"
  const shopMap = new Map(); // key → { name, city, deliveryGroupId }
  for (const row of records) {
    const name  = String(row.shopName  || '').trim();
    const city  = String(row.shopCity  || '').trim();
    const gId   = String(row.deliveryGroupId || '').trim();
    if (!name || !city) continue;
    const key = `${name}|${city}`;
    if (!shopMap.has(key)) {
      shopMap.set(key, { name, city, deliveryGroupId: gId });
    }
  }

  console.log(`🏪 Унікальних магазинів (name+city): ${shopMap.size}`);

  // ─── 2. Збираємо унікальні міста ──────────────────────────────────────────
  const cities = [...new Set([...shopMap.values()].map((s) => s.city))].sort();
  console.log(`🏙️  Унікальних міст: ${cities.length}: ${cities.join(', ')}\n`);

  // ─── 3. Dry-run: показуємо що буде ────────────────────────────────────────
  if (dryRun) {
    console.log('⚠️  DRY-RUN — реальних змін немає. Додай --run щоб виконати.\n');
    console.log('Магазини що будуть створені (або пропущені якщо вже існують):');
    let i = 1;
    for (const [key, shop] of shopMap) {
      const existing = await shopsCol.findOne({ name: shop.name, city: shop.city });
      const status = existing ? '⏭  вже існує' : '➕ новий';
      console.log(`  ${i++}. ${status}  "${shop.name}" / ${shop.city} / groupId=${shop.deliveryGroupId || '—'}`);
    }
    console.log('\n\u041f\u0440\u043e\u0434\u0430\u0432\u0446\u0456 \u0449\u043e \u0431\u0443\u0434\u0443\u0442\u044c \u043f\u0440\u0438\u0432\u0027\u044f\u0437\u0430\u043d\u0456 \u0434\u043e \u043c\u0430\u0433\u0430\u0437\u0438\u043d\u0456\u0432:');
    let linked = 0, skipped = 0;
    for (const row of records) {
      const name = String(row.shopName || '').trim();
      const city = String(row.shopCity || '').trim();
      if (!name || !city || !row.telegramId) { skipped++; continue; }
      const shop = await shopsCol.findOne({ name, city });
      if (shop) {
        console.log(`  ✅ ${row.firstName} ${row.lastName} → "${name}" / ${city}`);
        linked++;
      } else {
        console.log(`  ➕ ${row.firstName} ${row.lastName} → "${name}" / ${city} (магазин буде створений)`);
        linked++;
      }
    }
    if (skipped) console.log(`  ⚠️  Пропущено (без назви або міста): ${skipped}`);
    await mongoose.disconnect();
    process.exit(0);
  }

  // ─── 4. Реальний запис ────────────────────────────────────────────────────
  const shopIdCache = new Map(); // "name|city" → ObjectId (string)

  let created = 0, skipped = 0;
  for (const [key, shop] of shopMap) {
    const existing = await shopsCol.findOne({ name: shop.name, city: shop.city });
    if (existing) {
      shopIdCache.set(key, String(existing._id));
      console.log(`⏭  Вже існує: "${shop.name}" / ${shop.city}`);
      skipped++;
    } else {
      const result = await shopsCol.insertOne({
        name:            shop.name,
        city:            shop.city,
        deliveryGroupId: shop.deliveryGroupId,
        address:         '',
        isActive:        true,
        createdAt:       new Date(),
        updatedAt:       new Date(),
      });
      shopIdCache.set(key, String(result.insertedId));
      console.log(`➕ Створено: "${shop.name}" / ${shop.city}`);
      created++;
    }
  }
  console.log(`\n✅ Магазини: ${created} створено, ${skipped} вже існували\n`);

  // ─── 5. Прив'язуємо продавців ─────────────────────────────────────────────
  let linkedCount = 0, missingShop = 0, missingUser = 0;
  for (const row of records) {
    const name = String(row.shopName || '').trim();
    const city = String(row.shopCity || '').trim();
    if (!name || !city || !row.telegramId) { missingShop++; continue; }

    const key    = `${name}|${city}`;
    const shopId = shopIdCache.get(key);
    if (!shopId) { missingShop++; continue; }

    const result = await usersCol.updateOne(
      { telegramId: String(row.telegramId) },
      { $set: { shopId: new mongoose.Types.ObjectId(shopId), updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) {
      console.warn(`  ⚠️  Продавця не знайдено в БД: telegramId=${row.telegramId}`);
      missingUser++;
    } else {
      linkedCount++;
    }
  }
  console.log(`✅ Продавці: ${linkedCount} прив'язано, ${missingUser} не знайдено, ${missingShop} без магазину\n`);

  // ─── 6. Зберігаємо список міст в AppSettings ──────────────────────────────
  await appSettingsCol.updateOne(
    { key: 'shops.cities' },
    { $set: { key: 'shops.cities', value: cities, updatedAt: new Date() } },
    { upsert: true }
  );
  console.log(`✅ AppSettings shops.cities збережено (${cities.length} міст)\n`);

  console.log('🎉 Seeding завершено!');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('❌ Помилка:', err.message);
  process.exit(1);
});
