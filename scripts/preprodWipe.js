'use strict';

/**
 * Pre-production data wipe.
 *
 * Keeps only the REAL business entities and config; resets everything
 * transactional/transient so the app starts production from a clean slate.
 *
 *   KEEP  : users (cart/history reset), shops, cities, groupmembers,
 *           deliverygroups, appsettings
 *   WIPE  : orders, picking, catalog (products/shopproducts/productvectors/
 *           blocks/searchproducts), receipts, ordering sessions, logs, tokens
 *   DROP  : dead collections with no live model
 *   RESET : all counters (orderNumber restarts at #1); users.cartState /
 *           miniAppState / history
 *
 * SAFE BY DEFAULT: dry-run prints what WOULD change. Pass --execute to write.
 *
 *   node scripts/preprodWipe.js              # dry-run
 *   node scripts/preprodWipe.js --execute    # perform the wipe
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');

// Collections emptied but kept (indexes/shape preserved).
const WIPE = [
  'orders',
  'pickingtasks',
  'clearedcarts',
  'shoptransferrequests',
  'productfeedbacks',
  'registrationrequests',
  'registrationtokens',
  'googlelinktokens',
  'shopauditlogs',
  'visiontestlogs',
  'receiptitemlogs',
  'botinteractionlogs',
  'products',
  'shopproducts',
  'productvectors',
  'blocks',
  'searchproducts',
  'receipts',
  'receiptitems',
  'orderingsessions',
];

// Dead collections — no live model references them. Dropped entirely.
const DROP_DEAD = ['pricerequests', 'botsessions', 'pendingreactions', 'warehousetasks'];

// Kept untouched (listed only for the report).
const KEEP = ['users', 'shops', 'cities', 'groupmembers', 'deliverygroups', 'appsettings'];

const CART_DEFAULT = {
  orderItems: {},
  orderItemIds: [],
  lastOrderPositions: 0,
  lastViewedProductId: '',
  lastViewedOrderNumber: 0,
  currentIndex: 0,
  currentPage: 0,
  updatedAt: null,
};
const MINIAPP_DEFAULT = {
  lastViewedProductId: '',
  currentIndex: 0,
  currentPage: 0,
  viewMode: 'carousel',
  updatedAt: null,
};

async function main() {
  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const dbName = db.databaseName;

  console.log(`\n${EXECUTE ? '⚠️  EXECUTE' : '🔍 DRY-RUN'} — database: ${dbName}\n`);

  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const count = async (n) => (existing.has(n) ? db.collection(n).estimatedDocumentCount() : 0);

  // ── KEEP report ──
  console.log('✅ KEEP (untouched):');
  for (const n of KEEP) console.log(`   ${String(await count(n)).padStart(6)}  ${n}`);

  // ── WIPE ──
  console.log('\n🗑️  WIPE (delete all docs):');
  let wiped = 0;
  for (const n of WIPE) {
    if (!existing.has(n)) { console.log(`   ${'—'.padStart(6)}  ${n} (absent)`); continue; }
    const c = await count(n);
    console.log(`   ${String(c).padStart(6)}  ${n}`);
    if (EXECUTE && c > 0) { const r = await db.collection(n).deleteMany({}); wiped += r.deletedCount; }
  }

  // ── DROP dead ──
  console.log('\n💀 DROP (dead collections):');
  for (const n of DROP_DEAD) {
    if (!existing.has(n)) { console.log(`   ${'—'.padStart(6)}  ${n} (absent)`); continue; }
    const c = await count(n);
    console.log(`   ${String(c).padStart(6)}  ${n}`);
    if (EXECUTE) { try { await db.collection(n).drop(); } catch (e) { if (e.codeName !== 'NamespaceNotFound') throw e; } }
  }

  // ── COUNTERS ──
  const counterCount = await count('counters');
  console.log(`\n🔢 COUNTERS reset: ${counterCount} docs (orderNumber/blockId/receiptNumber/session-seq) → recreated lazily; orderNumber restarts at #1`);
  if (EXECUTE && existing.has('counters')) await db.collection('counters').deleteMany({});

  // ── USERS reset (identity kept, transactional fields cleared) ──
  const usersTotal = await count('users');
  const usersWithHistory = existing.has('users')
    ? await db.collection('users').countDocuments({ 'history.0': { $exists: true } })
    : 0;
  console.log(`\n👤 USERS reset: cartState + miniAppState + history on ${usersTotal} users (history non-empty on ${usersWithHistory})`);
  if (EXECUTE && existing.has('users')) {
    const r = await db.collection('users').updateMany({}, {
      $set: { cartState: CART_DEFAULT, miniAppState: MINIAPP_DEFAULT, history: [] },
    });
    console.log(`   users modified: ${r.modifiedCount}`);
  }

  if (EXECUTE) console.log(`\n✔ Done. Wiped ${wiped} docs across ${WIPE.length} collections.`);
  else console.log('\nℹ️  Dry-run only — nothing was written. Re-run with --execute to apply.');

  await mongoose.disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
