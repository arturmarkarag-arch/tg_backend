'use strict';

/**
 * Прибирає знятий прапорець `supplementOffer` з документів ReceiptItem.
 *
 * Дозамовлення стало властивістю НАКЛАДНОЇ (Receipt.type='supplement'), а поле
 * на позиції зникло зі схеми. Дані від цього не ламаються — Mongoose просто не
 * читає зайве поле, — але воно лишається в кожному документі й вводить в оману
 * будь-кого, хто зазирне в базу напряму.
 *
 * ЧОМУ .collection, а не звичайний updateMany: у strict-режимі Mongoose ТИХО
 * викидає з $unset поля, яких немає у схемі. Запит рапортує modifiedCount > 0 і
 * не змінює нічого. Тому йдемо повз схему — на нативний драйвер.
 *
 * SAFE BY DEFAULT: без --execute лише рахує.
 *
 *   node scripts/dropSupplementOfferField.js              # скільки документів
 *   node scripts/dropSupplementOfferField.js --execute    # прибрати поле
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI не заданий');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const col = mongoose.connection.collection('receiptitems');

  // read=primary: одразу після запису репліка могла ще не наздогнати, і
  // «залишилось 0» було б неправдою.
  const before = await col.countDocuments({ supplementOffer: { $exists: true } }, { readPreference: 'primary' });
  console.log(`Документів із полем supplementOffer: ${before}`);

  if (!before) {
    await mongoose.disconnect();
    return;
  }

  if (!EXECUTE) {
    console.log('Dry-run — нічого не змінено. Запустіть із --execute, щоб прибрати поле.');
    await mongoose.disconnect();
    return;
  }

  const res = await col.updateMany(
    { supplementOffer: { $exists: true } },
    { $unset: { supplementOffer: '' } },
  );
  const after = await col.countDocuments({ supplementOffer: { $exists: true } }, { readPreference: 'primary' });
  console.log(`Оновлено: ${res.modifiedCount}. Залишилось із полем: ${after}`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
