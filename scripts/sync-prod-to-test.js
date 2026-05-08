/**
 * sync-prod-to-test.js
 *
 * Повний дамп усіх колекцій з PROD → TEST (upsert by _id).
 * Не видаляє існуючих записів у TEST — тільки додає/оновлює.
 *
 * Використання:
 *   node scripts/sync-prod-to-test.js              # dry-run (показує кількість)
 *   node scripts/sync-prod-to-test.js --run        # реальний запис
 *   node scripts/sync-prod-to-test.js --run --only shops,deliverygroups
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { MongoClient } = require('mongoose').mongo;

const PROD_URI =
  'mongodb+srv://danzakuduro32_db_user:NMQSb6q0KOSVqplx@cluster0.p5rmla3.mongodb.net/tg_manager?retryWrites=true&w=majority';

const TEST_URI = process.env.MONGODB_URI; // з .env

if (!TEST_URI) {
  console.error('❌ MONGODB_URI not found in .env');
  process.exit(1);
}

const DRY_RUN = !process.argv.includes('--run');
const onlyArg = process.argv.find((a) => a.startsWith('--only=') || a === '--only');
let onlyCollections = null;
if (onlyArg) {
  const idx = process.argv.indexOf('--only');
  const val = onlyArg.startsWith('--only=') ? onlyArg.slice(7) : process.argv[idx + 1];
  if (val) onlyCollections = val.toLowerCase().split(',').map((s) => s.trim());
}

// Колекції які НЕ копіюємо (логи, сесії, системні)
const SKIP_COLLECTIONS = new Set([
  'botinteractionlogs',
  'botsessions',
  'activitylogs',
  'sessions',
  'pendingorders',          // transient
  'pendingreactions',       // transient
]);

async function main() {
  console.log(DRY_RUN ? '🔍 DRY-RUN mode (use --run to write)' : '✍️  WRITE mode');
  console.log('PROD:', PROD_URI.split('@')[1]);
  console.log('TEST:', TEST_URI.split('@')[1] || TEST_URI);
  if (onlyCollections) console.log('Only:', onlyCollections.join(', '));
  console.log('');

  const prod = new MongoClient(PROD_URI);
  const test = new MongoClient(TEST_URI);

  try {
    await prod.connect();
    await test.connect();
    console.log('✅ Connected to both databases\n');

    const prodDb = prod.db('tg_manager');
    const testDb = test.db(); // default db from URI

    const collections = await prodDb.listCollections().toArray();
    const names = collections
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.'))
      .filter((n) => !SKIP_COLLECTIONS.has(n.toLowerCase()))
      .filter((n) => !onlyCollections || onlyCollections.includes(n.toLowerCase()));

    console.log(`Collections to sync (${names.length}):\n  ${names.join(', ')}\n`);

    let totalUpserted = 0;
    let totalSkipped = 0;

    for (const name of names) {
      const docs = await prodDb.collection(name).find({}).toArray();
      if (docs.length === 0) {
        console.log(`  ${name}: empty, skip`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  ${name}: ${docs.length} docs (dry-run)`);
        totalSkipped += docs.length;
        continue;
      }

      // Upsert by _id
      const ops = docs.map((doc) => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $setOnInsert: doc },
          upsert: true,
        },
      }));

      let upserted = 0;
      let matched = 0;
      let skippedDups = 0;
      try {
        const result = await testDb.collection(name).bulkWrite(ops, { ordered: false });
        upserted = result.upsertedCount;
        matched = result.matchedCount;
      } catch (err) {
        // BulkWriteError — частина операцій могла пройти
        if (err.name === 'MongoBulkWriteError' || err.code === 11000 || err.writeErrors) {
          upserted = err.result?.upsertedCount ?? 0;
          matched = err.result?.matchedCount ?? 0;
          skippedDups = err.writeErrors?.length ?? 0;
        } else {
          throw err;
        }
      }
      const dupMsg = skippedDups ? `, ${skippedDups} dup-skip` : '';
      console.log(`  ${name}: ${docs.length} docs → +${upserted} new, ${matched} already exist${dupMsg}`);
      totalUpserted += upserted;
    }

    if (DRY_RUN) {
      console.log(`\n📊 DRY-RUN: would process ${totalSkipped} docs across ${names.length} collections`);
      console.log('Run with --run to apply.');
    } else {
      console.log(`\n✅ Done. Inserted ${totalUpserted} new documents.`);
    }
  } finally {
    await prod.close();
    await test.close();
  }
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
