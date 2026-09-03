'use strict';

/**
 * wipeOrderCycle — прибирає сліди ТЕСТОВОГО циклу замовлень.
 *
 * Стирає лише транзакційний шар: замовлення, збирання, сесії замовлення,
 * дозамовлення, позначки «переглянув каталог», збережені кошики та історії.
 * Каталог, склад, блоки, вектори, накладні, магазини, групи, користувачі
 * (самі акаунти) і налаштування ЛИШАЮТЬСЯ на місці.
 *
 * Не плутати з scripts/preprodWipe.js — той зносить ще й каталог із накладними.
 *
 * ІНДЕКСИ скидати не треба: deleteMany видаляє документи, а індекси лишає, і
 * сервер на старті все одно робить syncIndexes() для Order / PickingTask /
 * SupplementWave / SupplementOffer / SupplementRequest / User (server/index.js). Прапорець
 * --sync-indexes лише дає зробити те саме без перезапуску сервера.
 *
 * БЕЗПЕЧНО ЗА ЗАМОВЧУВАННЯМ: без --execute це dry-run, який тільки рахує.
 *
 *   node scripts/wipeOrderCycle.js                        # dry-run (нічого не пише)
 *   node scripts/wipeOrderCycle.js --execute              # виконати чистку
 *   node scripts/wipeOrderCycle.js --execute --with-logs  # + журнали магазинів/бота
 *   node scripts/wipeOrderCycle.js --execute --with-feedback   # + «Проблеми з товаром»
 *   node scripts/wipeOrderCycle.js --execute --keep-carts      # не чіпати кошики продавців
 *   node scripts/wipeOrderCycle.js --execute --keep-counters   # не скидати нумерацію замовлень
 *   node scripts/wipeOrderCycle.js --execute --sync-indexes    # ще й перезібрати індекси
 *   node scripts/wipeOrderCycle.js --execute --force           # без 5-секундної паузи
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

const EXECUTE       = has('--execute');
const WITH_LOGS     = has('--with-logs');
const WITH_FEEDBACK = has('--with-feedback');
const KEEP_CARTS    = has('--keep-carts');
const KEEP_COUNTERS = has('--keep-counters');
const SYNC_INDEXES  = has('--sync-indexes');
const FORCE         = has('--force');

// ── Транзакційний шар циклу замовлень — стирається завжди ────────────────────
const CORE = [
  ['orders',             'замовлення (разом з їх history)'],
  ['pickingtasks',       'задачі збирання'],
  // Відродиться сама: getOrCreateSessionId() створює сесію групи при першому ж
  // вході в мініапку. Це нормально — нова сесія порожня (seq: null, pending).
  ['orderingsessions',   'сесії замовлення (номери «Сесія №X»)'],
  ['catalogreviews',     'позначки «я переглянув каталог»'],
  ['supplementwaves',    'хвилі дозамовлення'],
  ['supplementoffers',   'позиції/legacy-пропозиції дозамовлення'],
  ['supplementrequests', 'заявки магазинів на дозамовлення'],
  ['clearedcarts',       'знімки очищених кошиків'],
];

// ── Журнали (--with-logs) ────────────────────────────────────────────────────
const LOGS = [
  ['shopauditlogs',      'журнал дій по магазинах'],
  ['botinteractionlogs', 'журнал взаємодій з ботом'],
];

// ── Фідбек по товарах (--with-feedback) ──────────────────────────────────────
const FEEDBACK = [
  ['productfeedbacks', 'скарги «Проблеми з товаром?»'],
];

// Дефолти піддокументів User — мають збігатися зі схемою models/User.js.
const CART_DEFAULT = {
  orderItems: {},
  orderItemIds: [],
  lastOrderPositions: 0,
  navigationSessionId: '',
  lastViewedProductId: '',
  lastViewedOrderNumber: 0,
  currentIndex: 0,
  currentPage: 0,
  updatedAt: null,
};
const MINIAPP_DEFAULT = {
  updatedAt: null,
};

const pad = (n) => String(n).padStart(7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI не заданий у .env — нічого робити.');
    process.exit(2);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const host = mongoose.connection.host || '(невідомий host)';

  console.log(`\n${EXECUTE ? '⚠️  ЗАПИС (--execute)' : '🔍 DRY-RUN (нічого не пишеться)'}`);
  console.log(`   база: ${db.databaseName}   host: ${host}\n`);

  if (EXECUTE && !FORCE) {
    console.log('   Чистка почнеться через 5 секунд. Ctrl+C — скасувати.');
    await sleep(5000);
  }

  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const count = async (n) => (existing.has(n) ? db.collection(n).countDocuments() : 0);

  // ── Знімок «що тести встигли зробити», зроблений ДО видалення ─────────────
  const oldestOrder = existing.has('orders')
    ? await db.collection('orders').find({}, { projection: { createdAt: 1 } }).sort({ createdAt: 1 }).limit(1).next()
    : null;
  const oosTasks = existing.has('pickingtasks')
    ? await db.collection('pickingtasks').countDocuments({ completionReason: 'out_of_stock' })
    : 0;
  const archivedSinceTests = (existing.has('products') && oldestOrder?.createdAt)
    ? await db.collection('products').countDocuments({ status: 'archived', archivedAt: { $gte: oldestOrder.createdAt } })
    : 0;

  // ── Чистка ────────────────────────────────────────────────────────────────
  const groups = [
    ['🗑️  ЦИКЛ ЗАМОВЛЕНЬ', CORE, true],
    ['📓 ЖУРНАЛИ', LOGS, WITH_LOGS],
    ['💬 ФІДБЕК ПО ТОВАРАХ', FEEDBACK, WITH_FEEDBACK],
  ];

  let deleted = 0;
  for (const [title, list, enabled] of groups) {
    console.log(`${title}${enabled ? '' : '  — пропущено (прапорець не заданий)'}:`);
    for (const [name, label] of list) {
      const c = await count(name);
      const mark = !enabled ? 'skip' : (existing.has(name) ? pad(c) : '   —   ');
      console.log(`   ${mark}  ${name.padEnd(20)} ${label}`);
      if (enabled && EXECUTE && c > 0) {
        const r = await db.collection(name).deleteMany({});
        deleted += r.deletedCount;
      }
    }
    console.log('');
  }

  // ── Лічильники: тільки ті, що належать циклу замовлень ────────────────────
  // blockId і receiptNumber НЕ чіпаємо — блоки й накладні лишаються жити.
  const counterFilter = { $or: [{ name: 'orderNumber' }, { name: { $regex: '^session-seq:' } }] };
  const counterDocs = existing.has('counters')
    ? await db.collection('counters').find(counterFilter, { projection: { name: 1, seq: 1 } }).toArray()
    : [];
  console.log(`🔢 ЛІЧИЛЬНИКИ${KEEP_COUNTERS ? '  — пропущено (--keep-counters)' : ''}:`);
  if (!counterDocs.length) console.log('        —   немає що скидати');
  for (const c of counterDocs) console.log(`   ${pad(c.seq)}  ${c.name}  → буде створений наново з 1`);
  const kept = existing.has('counters')
    ? await db.collection('counters').find({ name: { $in: ['blockId', 'receiptNumber'] } }, { projection: { name: 1, seq: 1 } }).toArray()
    : [];
  for (const c of kept) console.log(`   ${pad(c.seq)}  ${c.name}  ← лишається недоторканим`);
  if (EXECUTE && !KEEP_COUNTERS && counterDocs.length) {
    const r = await db.collection('counters').deleteMany(counterFilter);
    deleted += r.deletedCount;
  }
  console.log('');

  // ── Користувачі: кошики / стан мініапки / історія ─────────────────────────
  const usersTotal = await count('users');
  const usersWithCart = existing.has('users')
    ? await db.collection('users').countDocuments({ 'cartState.orderItemIds.0': { $exists: true } })
    : 0;
  const usersWithHistory = existing.has('users')
    ? await db.collection('users').countDocuments({ 'history.0': { $exists: true } })
    : 0;
  console.log(`👤 КОРИСТУВАЧІ${KEEP_CARTS ? '  — пропущено (--keep-carts)' : ''}:`);
  console.log(`   ${pad(usersTotal)}  акаунтів усього (самі акаунти НЕ видаляються)`);
  console.log(`   ${pad(usersWithCart)}  з непорожнім кошиком → кошик очищається`);
  console.log(`   ${pad(usersWithHistory)}  з непорожньою історією → історія очищається`);
  if (EXECUTE && !KEEP_CARTS && existing.has('users')) {
    const r = await db.collection('users').updateMany({}, {
      $set: { cartState: CART_DEFAULT, miniAppState: MINIAPP_DEFAULT, history: [] },
    });
    console.log(`   змінено акаунтів: ${r.modifiedCount}`);
  }
  console.log('');

  // ── Накладні-дозамовлення: щоб планувальник не воскресив пропозиції ───────
  // services/supplementScheduler.js періодично викликає reconcilePendingReceipts(),
  // яка перестворює пропозиції для накладних зі supplementStatus:'pending'.
  // Після видалення пропозицій такі накладні треба перевести в 'ready'.
  const pendingReceipts = existing.has('receipts')
    ? await db.collection('receipts').countDocuments({ supplementStatus: 'pending' })
    : 0;
  console.log('🧾 НАКЛАДНІ (самі накладні НЕ видаляються):');
  console.log(`   ${pad(pendingReceipts)}  зі supplementStatus:'pending' → переводяться в 'ready',`);
  console.log('            інакше планувальник дозамовлень створить пропозиції заново');
  if (EXECUTE && pendingReceipts > 0) {
    await db.collection('receipts').updateMany(
      { supplementStatus: 'pending' },
      { $set: { supplementStatus: 'ready' } },
    );
  }
  console.log('');

  // ── Індекси (опційно) ─────────────────────────────────────────────────────
  console.log('🧩 ІНДЕКСИ:');
  if (!SYNC_INDEXES) {
    console.log('        —   не чіпаємо: deleteMany індекси не ламає, а сервер на старті');
    console.log('            сам робить syncIndexes(). Прапорець --sync-indexes — якщо');
    console.log('            треба привести їх до схеми без перезапуску сервера.');
  } else if (!EXECUTE) {
    console.log('        —   --sync-indexes спрацює тільки разом з --execute');
  } else {
    const models = [
      ['Order',             require('../models/Order')],
      ['PickingTask',       require('../models/PickingTask')],
      ['OrderingSession',   require('../models/OrderingSession')],
      ['SupplementWave',    require('../models/SupplementWave')],
      ['SupplementOffer',   require('../models/SupplementOffer')],
      ['SupplementRequest', require('../models/SupplementRequest')],
      ['CatalogReview',     require('../models/CatalogReview')],
      ['User',              require('../models/User')],
    ];
    for (const [name, model] of models) {
      try {
        const dropped = await model.syncIndexes();
        console.log(`   ✔ ${name.padEnd(18)} ok${dropped?.length ? `, видалено застарілих: ${dropped.join(', ')}` : ''}`);
      } catch (err) {
        console.error(`   ✖ ${name.padEnd(18)} ${err.message}`);
      }
    }
  }
  console.log('');

  // ── Що чистка НЕ виправляє — вручну ───────────────────────────────────────
  console.log('ℹ️  ЗАЛИШАЄТЬСЯ ПІСЛЯ ЧИСТКИ (скрипт це не чіпає):');
  console.log(`   ${pad(oosTasks)}  задач збирання були закриті як «Закінчився» під час тестів`);
  console.log(`   ${pad(archivedSinceTests)}  товарів у статусі archived від початку тестів`);
  console.log('            → якщо це тестові списання, поверніть їх через «Архів» у мініапці');
  console.log('              (штатний restore кладе товар у «Надходження»)');
  if (existing.has('deliverygroups')) {
    const scheduleGroups = await db.collection('deliverygroups')
      .find({}, { projection: { name: 1, orderingSchedule: 1 } })
      .sort({ name: 1 })
      .toArray();
    if (scheduleGroups.length) {
      console.log('   індивідуальні графіки груп (DeliveryGroup.orderingSchedule):');
      for (const group of scheduleGroups) {
        console.log(`            • ${group.name || group._id}: ${JSON.stringify(group.orderingSchedule || null)}`);
      }
      console.log('            → E2E v24 змінює тільки synthetic test group, бойові графіки не чіпає');
    }
  }
  console.log('');

  if (EXECUTE) console.log(`✔ Готово. Видалено документів: ${deleted}.`);
  else console.log('ℹ️  Dry-run — нічого не записано. Повторіть з --execute, щоб застосувати.');

  await mongoose.disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
