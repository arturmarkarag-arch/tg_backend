/**
 * EXPORT: Витягує всіх Продавців з MongoDB і зберігає у shops-export.json
 *
 * Вивід на екран:
 *   telegramId | shopName | shopCity | deliveryGroupId | deliveryGroupName | dayOfWeek
 *
 * Файл shops-export.json можна потім передати в import-shops.js
 *
 * Run:
 *   node server/scripts/export-shops.js
 *   node server/scripts/export-shops.js --csv   (додатково зберегти CSV)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tg_manager';

const DAY_UK = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Підключено до MongoDB:', MONGODB_URI);

  const db = mongoose.connection.db;
  const usersCol = db.collection('users');
  const groupsCol = db.collection('deliverygroups');

  // Завантажуємо всі групи в Map: id → { name, dayOfWeek }
  const allGroups = await groupsCol.find({}).toArray();
  const groupMap = new Map(
    allGroups.map((g) => [String(g._id), { name: g.name, dayOfWeek: g.dayOfWeek }])
  );

  // Всі продавці (role = 'seller')
  const sellers = await usersCol
    .find({ role: 'seller' })
    .sort({ shopCity: 1, shopName: 1 })
    .toArray();

  const rows = sellers.map((u) => {
    const gId = String(u.deliveryGroupId || '');
    const group = groupMap.get(gId) || null;
    return {
      telegramId:        String(u.telegramId || ''),
      firstName:         u.firstName || '',
      lastName:          u.lastName || '',
      shopName:          u.shopName || '',
      shopCity:          u.shopCity || '',
      shopAddress:       u.shopAddress || '',
      deliveryGroupId:   gId,
      deliveryGroupName: group?.name || '',
      dayOfWeek:         group?.dayOfWeek ?? '',
      dayOfWeekLabel:    group ? (DAY_UK[group.dayOfWeek] || '') : '',
    };
  });

  // ── Вивід в консоль ──────────────────────────────────────────
  const colW = [14, 22, 20, 20, 10, 6];
  const header = [
    'telegramId'.padEnd(colW[0]),
    'shopName'.padEnd(colW[1]),
    'shopCity'.padEnd(colW[2]),
    'deliveryGroup'.padEnd(colW[3]),
    'day'.padEnd(colW[4]),
    'groupId'.padEnd(colW[5]),
  ].join(' | ');
  console.log('\n' + header);
  console.log('-'.repeat(header.length));

  for (const r of rows) {
    const line = [
      r.telegramId.padEnd(colW[0]),
      r.shopName.slice(0, colW[1]).padEnd(colW[1]),
      r.shopCity.slice(0, colW[2]).padEnd(colW[2]),
      r.deliveryGroupName.slice(0, colW[3]).padEnd(colW[3]),
      r.dayOfWeekLabel.padEnd(colW[4]),
      r.deliveryGroupId.slice(-6).padEnd(colW[5]),
    ].join(' | ');
    console.log(line);
  }

  console.log(`\nВсього продавців: ${rows.length}`);

  // ── JSON export ──────────────────────────────────────────────
  const outJson = path.join(__dirname, 'shops-export.json');
  fs.writeFileSync(outJson, JSON.stringify(rows, null, 2), 'utf-8');
  console.log(`\n📄 JSON збережено: ${outJson}`);

  // ── CSV export (опціонально) ─────────────────────────────────
  if (process.argv.includes('--csv')) {
    const csvHeader = Object.keys(rows[0] || {}).join(',');
    const csvRows = rows.map((r) =>
      Object.values(r)
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    const outCsv = path.join(__dirname, 'shops-export.csv');
    fs.writeFileSync(outCsv, [csvHeader, ...csvRows].join('\n'), 'utf-8');
    console.log(`📊 CSV збережено:  ${outCsv}`);
  }

  await mongoose.disconnect();
  console.log('Готово.');
}

run().catch((err) => {
  console.error('❌ Помилка:', err);
  process.exit(1);
});
