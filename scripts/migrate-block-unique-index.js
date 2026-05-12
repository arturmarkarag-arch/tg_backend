/**
 * Міграція: вмикає унікальний multikey-індекс на Block.productIds.
 *
 * Що робить:
 *   1. Знаходить товари, які зараз потрапили в кілька блоків (баг до фіксу).
 *   2. Залишає товар у блоці з НАЙМЕНШИМ blockId, видаляє з решти.
 *   3. Дропає старий не-унікальний індекс productIds_1.
 *   4. Створює новий { productIds: 1 } з { unique: true, sparse: true }.
 *
 * Ідемпотентний — повторний запуск не змінює нічого, якщо все вже узгоджено.
 *
 * Запуск:
 *   node server/scripts/migrate-block-unique-index.js
 *
 * Передумови:
 *   - MONGODB_URI у .env
 *   - Запускати на тиху годину; пише у production-колекцію.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Block = require('../models/Block');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  // 1. Знаходимо дублікати: товари у >1 блоці
  const duplicates = await Block.aggregate([
    { $unwind: '$productIds' },
    { $group: { _id: '$productIds', blocks: { $push: { blockId: '$blockId', _id: '$_id' } }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  console.log(`Found ${duplicates.length} products that exist in multiple blocks`);

  for (const dup of duplicates) {
    const sortedBlocks = dup.blocks.sort((a, b) => a.blockId - b.blockId);
    const keep = sortedBlocks[0];
    const removeFrom = sortedBlocks.slice(1);

    console.log(
      `  product ${dup._id}: keep in #${keep.blockId}, remove from [${removeFrom
        .map((b) => '#' + b.blockId)
        .join(', ')}]`
    );

    for (const blk of removeFrom) {
      await Block.updateOne(
        { _id: blk._id },
        { $pull: { productIds: dup._id }, $inc: { version: 1 } }
      );
    }
  }

  // 2. Дропаємо старий індекс, якщо є і він не unique
  const indexes = await Block.collection.indexes();
  const productIdx = indexes.find((i) => i.name === 'productIds_1');

  if (productIdx && !productIdx.unique) {
    console.log('Dropping old non-unique productIds_1 index…');
    await Block.collection.dropIndex('productIds_1');
  } else if (productIdx && productIdx.unique) {
    console.log('Index productIds_1 already unique — skipping drop');
  }

  // 3. Створюємо/оновлюємо індекс через Mongoose syncIndexes
  console.log('Syncing indexes from schema…');
  const syncResult = await Block.syncIndexes();
  console.log('  result:', syncResult);

  console.log('Done.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
