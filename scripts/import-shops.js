/**
 * IMPORT: Після того як адмін відредагував shops-export.json —
 * повертає кожному продавцю його shopName / shopCity / deliveryGroupId / shopAddress
 * по telegramId.
 *
 * Що робить:
 *   1. Читає shops-export.json (або файл переданий як аргумент)
 *   2. Для кожного рядка знаходить User за telegramId
 *   3. Оновлює поля: shopName, shopCity, shopAddress, deliveryGroupId, warehouseZone
 *   4. Синхронізує DeliveryGroup.members
 *
 * Режим dry-run (за замовчуванням — НЕ пише в базу, лише показує що зміниться):
 *   node server/scripts/import-shops.js --dry-run
 *
 * Реальний запис:
 *   node server/scripts/import-shops.js --run
 *
 * Кастомний файл:
 *   node server/scripts/import-shops.js --run --file server/scripts/shops-fixed.json
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tg_manager';

const isDryRun = !process.argv.includes('--run');
const fileArgIdx = process.argv.indexOf('--file');
const inputFile = fileArgIdx !== -1
  ? path.resolve(process.argv[fileArgIdx + 1])
  : path.join(__dirname, 'shops-export.json');

async function run() {
  if (!fs.existsSync(inputFile)) {
    console.error(`❌ Файл не знайдено: ${inputFile}`);
    console.error('   Спочатку запусти: node server/scripts/export-shops.js');
    process.exit(1);
  }

  const rows = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  console.log(`📄 Завантажено ${rows.length} рядків з ${inputFile}`);

  if (isDryRun) {
    console.log('\n⚠️  DRY-RUN режим — нічого не записується в базу.');
    console.log('   Щоб зберегти зміни: node server/scripts/import-shops.js --run\n');
  } else {
    console.log('\n🔴 РЕАЛЬНИЙ ЗАПИС — дані будуть змінені в базі!\n');
  }

  await mongoose.connect(MONGODB_URI);
  console.log('✅ Підключено до MongoDB:', MONGODB_URI);

  const db = mongoose.connection.db;
  const usersCol = db.collection('users');
  const groupsCol = db.collection('deliverygroups');

  // Завантажуємо всі групи для валідації deliveryGroupId
  const allGroups = await groupsCol.find({}).toArray();
  const validGroupIds = new Set(allGroups.map((g) => String(g._id)));
  const groupNameMap = new Map(allGroups.map((g) => [String(g._id), g.name]));

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const telegramId = String(row.telegramId || '').trim();
    if (!telegramId) {
      console.warn(`⚠️  Пропущено рядок без telegramId:`, row);
      skipped++;
      continue;
    }

    const user = await usersCol.findOne({ telegramId });
    if (!user) {
      console.warn(`⚠️  Юзер не знайдений: telegramId=${telegramId}`);
      skipped++;
      continue;
    }

    const newGroupId = String(row.deliveryGroupId || '').trim();
    if (newGroupId && !validGroupIds.has(newGroupId)) {
      console.error(`❌ Невалідний deliveryGroupId="${newGroupId}" для ${telegramId} — пропускаємо`);
      errors++;
      continue;
    }

    const groupName = newGroupId ? (groupNameMap.get(newGroupId) || '') : '';

    const patch = {
      shopName:        String(row.shopName || '').trim(),
      shopCity:        String(row.shopCity || '').trim(),
      shopAddress:     String(row.shopAddress || '').trim(),
      deliveryGroupId: newGroupId,
      warehouseZone:   groupName,
    };

    // Показуємо diff
    const changed = Object.entries(patch).filter(
      ([k, v]) => String(user[k] || '') !== String(v)
    );

    if (changed.length === 0) {
      console.log(`  ⏭  ${telegramId} (${user.firstName} ${user.lastName}) — без змін`);
      skipped++;
      continue;
    }

    const diffStr = changed
      .map(([k, v]) => `${k}: "${user[k] || ''}" → "${v}"`)
      .join(', ');
    console.log(`  ${isDryRun ? '🔍' : '✏️ '} ${telegramId} (${user.firstName} ${user.lastName}): ${diffStr}`);

    if (!isDryRun) {
      await usersCol.updateOne({ telegramId }, { $set: patch });

      // Синхронізація DeliveryGroup.members
      await groupsCol.updateMany({ members: telegramId }, { $pull: { members: telegramId } });
      if (newGroupId) {
        await groupsCol.updateOne(
          { _id: new mongoose.Types.ObjectId(newGroupId) },
          { $addToSet: { members: telegramId } }
        );
      }
    }

    updated++;
  }

  console.log(`\n─────────────────────────────`);
  console.log(`Оновлено:  ${updated}`);
  console.log(`Пропущено: ${skipped}`);
  console.log(`Помилок:   ${errors}`);
  if (isDryRun) {
    console.log(`\nЦе був dry-run. Для реального запису: --run`);
  } else {
    console.log(`\n✅ Імпорт завершено.`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('❌ Критична помилка:', err);
  process.exit(1);
});
