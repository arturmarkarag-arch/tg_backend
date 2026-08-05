'use strict';

/**
 * Прибирає знятий з моделі DeliveryGroup.members із живих документів.
 *
 * Поле більше не в схемі (див. models/DeliveryGroup.js), тож код його не бачить —
 * але в базі воно лишається і далі важить, поки не зняти явно.
 *
 * ЧОМУ НАТИВНА КОЛЕКЦІЯ, А НЕ МОДЕЛЬ: Mongoose у strict-режимі ТИХО викидає з
 * $set/$unset усі поля поза схемою. `DeliveryGroup.updateMany({}, { $unset: { members: '' } })`
 * відрапортує modifiedCount > 0 і не змінить нічого. Тому пишемо через
 * Model.collection, а перевіряємо countDocuments з читанням із primary.
 *
 * Запуск:
 *   node scripts/dropDeliveryGroupMembers.js            # лише показати
 *   node scripts/dropDeliveryGroupMembers.js --execute  # реально зняти
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const DeliveryGroup = require('../models/DeliveryGroup');

const EXECUTE = process.argv.includes('--execute');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI не заданий (очікується в NEW_VERSION/.env)');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const coll = DeliveryGroup.collection;

  const before = await coll.countDocuments({ members: { $exists: true } }, { readPreference: 'primary' });
  const total = await coll.countDocuments({}, { readPreference: 'primary' });
  console.log(`Груп доставки: ${total}, з полем members: ${before}`);

  if (before) {
    const rows = await coll.find({ members: { $exists: true } }, { projection: { name: 1, members: 1 } }).toArray();
    for (const r of rows) console.log(`  «${r.name}» → ${Array.isArray(r.members) ? r.members.length : 0} записів`);
  }

  if (!EXECUTE) {
    console.log('\nDRY-RUN. Щоб зняти поле, перезапустіть з --execute');
    await mongoose.disconnect();
    return;
  }

  const res = await coll.updateMany({ members: { $exists: true } }, { $unset: { members: '' } });
  const after = await coll.countDocuments({ members: { $exists: true } }, { readPreference: 'primary' });
  console.log(`\nЗнято: matched=${res.matchedCount} modified=${res.modifiedCount}`);
  console.log(`Лишилось документів з members: ${after}${after ? '  ← ЩОСЬ НЕ ТАК' : '  ✓'}`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
