'use strict';

/**
 * Прибирає знятий `orderingSessionId` (і `targetOrderingSessionId` на накладних)
 * із документів дозамовлення.
 *
 * Хвиля дозамовлення більше не прив'язана до OrderingSession — прив'язка лишилась
 * тільки до групи доставки (див. models/SupplementOffer.js). Дані від зайвого поля
 * не ламаються: Mongoose його просто не читає, — але воно лишається в кожному
 * документі й вводить в оману будь-кого, хто зазирне в базу напряму. Гірше:
 * старий індекс {orderingSessionId, status} лишився б у Mongo назавжди, бо
 * syncIndexes для цих колекцій не викликається.
 *
 * ЧОМУ .collection, а не звичайний updateMany: у strict-режимі Mongoose ТИХО
 * викидає з $unset поля, яких немає у схемі. Запит рапортує modifiedCount > 0 і
 * не змінює нічого. Тому йдемо повз схему — на нативний драйвер.
 *
 * Індекси знімаються теж вручну: dropIndex по імені, з тихим пропуском, якщо
 * його вже немає (IndexNotFound = 27).
 *
 * SAFE BY DEFAULT: без --execute лише рахує.
 *
 *   node scripts/dropSupplementSessionField.js              # що знайдено
 *   node scripts/dropSupplementSessionField.js --execute    # прибрати
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');

// [колекція, поле, індекси, які цим полем жили]
const TARGETS = [
  ['supplementoffers',   'orderingSessionId',       ['orderingSessionId_1_status_1']],
  ['supplementrequests', 'orderingSessionId',       ['orderingSessionId_1_shopId_1']],
  ['receipts',           'targetOrderingSessionId', []],
];

async function dropIndexIfPresent(col, name) {
  try {
    await col.dropIndex(name);
    console.log(`  індекс ${name} — знято`);
  } catch (err) {
    // 27 = IndexNotFound. Усе інше — справжня проблема, її показуємо.
    if (err?.code === 27 || /index not found/i.test(err?.message || '')) {
      console.log(`  індекс ${name} — уже відсутній`);
      return;
    }
    console.warn(`  індекс ${name} — не вдалося зняти: ${err.message}`);
  }
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI не заданий');
    process.exit(1);
  }

  await mongoose.connect(uri);

  for (const [name, field, indexes] of TARGETS) {
    const col = mongoose.connection.collection(name);
    // read=primary: одразу після запису репліка могла ще не наздогнати, і
    // «залишилось 0» було б неправдою.
    const before = await col.countDocuments({ [field]: { $exists: true } }, { readPreference: 'primary' });
    console.log(`${name}.${field}: ${before} документів`);

    if (!EXECUTE) {
      // Індекси показуємо і в dry-run: нуль документів НЕ означає «робити нічого».
      // Поле могло ніколи не заповнитись, а індекс під нього Mongo вже створила —
      // і сам він не зникне, бо syncIndexes для цих колекцій не викликається.
      if (indexes.length) {
        const existing = new Set((await col.indexes()).map((i) => i.name));
        for (const idx of indexes) {
          console.log(`  індекс ${idx}: ${existing.has(idx) ? 'ІСНУЄ — буде знято' : 'відсутній'}`);
        }
      }
      continue;
    }

    if (before) {
      const res = await col.updateMany({ [field]: { $exists: true } }, { $unset: { [field]: '' } });
      const after = await col.countDocuments({ [field]: { $exists: true } }, { readPreference: 'primary' });
      console.log(`  оновлено ${res.modifiedCount}, залишилось із полем ${after}`);
    }
    for (const idx of indexes) await dropIndexIfPresent(col, idx);
  }

  if (!EXECUTE) {
    console.log('\nDry-run — нічого не змінено. Запустіть із --execute, щоб прибрати поля та індекси.');
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
