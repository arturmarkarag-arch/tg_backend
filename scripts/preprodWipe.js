'use strict';

/**
 * Pre-production data wipe — чистка перед бойовим стартом.
 *
 * Лишає РЕАЛЬНІ сутності й конфіг, зносить увесь каталог і транзакційний шар,
 * щоб продакшн стартував з чистого аркуша (каталог заливається наново).
 *
 *   KEEP  : users (кошик/стан/історія обнуляються, identity+role+shop лишаються),
 *           shops, cities, groupmembers, deliverygroups, appsettings,
 *           registrationtokens (живі ZP-коди!), registrationrequests,
 *           googlelinktokens, shoptransferrequests
 *   WIPE  : каталог (products/shopproducts/productvectors/searchproducts/blocks),
 *           цикл замовлень (orders/pickingtasks/orderingsessions/catalogreviews/
 *           clearedcarts/supplementoffers/supplementrequests),
 *           накладні (receipts/receiptitems/receiptitemlogs),
 *           журнали (shopauditlogs/botinteractionlogs/visiontestlogs),
 *           productfeedbacks
 *   RESET : усі лічильники (orderNumber/blockId/receiptNumber/session-seq → з 1)
 *
 * ІНДЕКСИ (--reset-indexes): на ОЧИЩЕНИХ колекціях робиться dropIndexes (крім
 * _id_) і одразу model.syncIndexes() — індекси відновлюються рівно за схемою.
 * Колекції НЕ дропаються, тому Atlas Search / $vectorSearch індекс на
 * productvectors лишається живим. KEEP-колекції не чіпаються взагалі.
 *
 * БЕЗПЕЧНО ЗА ЗАМОВЧУВАННЯМ: без --execute це dry-run, який лише рахує.
 *
 *   node scripts/preprodWipe.js                              # dry-run
 *   node scripts/preprodWipe.js --execute                    # виконати чистку
 *   node scripts/preprodWipe.js --execute --reset-indexes    # + перезібрати індекси
 *   node scripts/preprodWipe.js --execute --force            # без 5-секундної паузи
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const EXECUTE       = has('--execute');
const RESET_INDEXES = has('--reset-indexes');
const FORCE         = has('--force');

// Колекції, що спорожняються. Модель потрібна, щоб (а) взяти справжню назву
// колекції, (б) відновити індекси за схемою.
const WIPE = [
  // ── каталог ───────────────────────────────────────────────────────────────
  ['Product',        '../models/Product',        'товари складу'],
  ['ShopProduct',    '../models/ShopProduct',    'товари магазинів (дзеркала + власні)'],
  ['ProductVector',  '../models/ProductVector',  'вектори фото-пошуку'],
  ['SearchProduct',  '../models/SearchProduct',  'легасі-пошук'],
  ['Block',          '../models/Block',          'блоки складу (полиці)'],
  // ── цикл замовлень ────────────────────────────────────────────────────────
  ['Order',            '../models/Order',            'замовлення'],
  ['PickingTask',      '../models/PickingTask',      'задачі збирання'],
  ['OrderingSession',  '../models/OrderingSession',  'сесії замовлення'],
  ['CatalogReview',    '../models/CatalogReview',    'позначки «переглянув каталог»'],
  ['ClearedCart',      '../models/ClearedCart',      'знімки очищених кошиків'],
  ['SupplementOffer',  '../models/SupplementOffer',  'пропозиції дозамовлення'],
  ['SupplementRequest','../models/SupplementRequest','заявки на дозамовлення'],
  // ── накладні ──────────────────────────────────────────────────────────────
  ['Receipt',        '../models/Receipt',        'накладні надходження'],
  ['ReceiptItem',    '../models/ReceiptItem',    'позиції накладних'],
  ['ReceiptItemLog', '../models/ReceiptItemLog', 'журнал позицій накладних'],
  // ── журнали / фідбек ──────────────────────────────────────────────────────
  ['ShopAuditLog',      '../models/ShopAuditLog',      'журнал дій по магазинах'],
  ['BotInteractionLog', '../models/BotInteractionLog', 'журнал взаємодій з ботом'],
  ['VisionTestLog',     '../models/VisionTestLog',     'журнал тестів фото-пошуку'],
  ['ProductFeedback',   '../models/ProductFeedback',   'скарги «Проблеми з товаром?»'],
];

// Не чіпаються (перелічені лише для звіту).
const KEEP = [
  ['users',                'акаунти (кошик/стан/історія обнуляються)'],
  ['shops',                'магазини'],
  ['cities',               'міста'],
  ['groupmembers',         'учасники Telegram-груп'],
  ['deliverygroups',       'групи доставки'],
  ['appsettings',          'налаштування (графік вікна замовлень тощо)'],
  ['registrationtokens',   'ZP-коди реєстрації — живі посилання'],
  ['registrationrequests', 'заявки на реєстрацію'],
  ['googlelinktokens',     'токени прив’язки Google'],
  ['shoptransferrequests', 'заявки на переведення магазинів'],
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
  lastViewedProductId: '',
  currentIndex: 0,
  currentPage: 0,
  viewMode: 'carousel',
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

  console.log(`\n${EXECUTE ? '⚠️  ЗАПИС (--execute)' : '🔍 DRY-RUN (нічого не пишеться)'}`);
  console.log(`   база: ${db.databaseName}   host: ${mongoose.connection.host}\n`);

  if (EXECUTE && !FORCE) {
    console.log('   Чистка почнеться через 5 секунд. Ctrl+C — скасувати.\n');
    await sleep(5000);
  }

  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const count = async (n) => (existing.has(n) ? db.collection(n).countDocuments() : 0);

  // ── KEEP (звіт) ───────────────────────────────────────────────────────────
  console.log('✅ ЛИШАЄТЬСЯ:');
  for (const [name, label] of KEEP) {
    console.log(`   ${existing.has(name) ? pad(await count(name)) : '   —   '}  ${name.padEnd(22)} ${label}`);
  }

  // ── WIPE ──────────────────────────────────────────────────────────────────
  console.log('\n🗑️  СТИРАЄТЬСЯ:');
  let deleted = 0;
  const wiped = [];
  for (const [modelName, modelPath, label] of WIPE) {
    const model = require(modelPath);
    const name = model.collection.collectionName;
    const c = await count(name);
    console.log(`   ${existing.has(name) ? pad(c) : '   —   '}  ${name.padEnd(22)} ${label}`);
    if (EXECUTE && c > 0) deleted += (await db.collection(name).deleteMany({})).deletedCount;
    if (existing.has(name)) wiped.push([modelName, model, name]);
  }

  // ── Лічильники ────────────────────────────────────────────────────────────
  const counterDocs = existing.has('counters')
    ? await db.collection('counters').find({}, { projection: { name: 1, seq: 1 } }).toArray()
    : [];
  console.log('\n🔢 ЛІЧИЛЬНИКИ (створяться наново з 1):');
  if (!counterDocs.length) console.log('        —   немає що скидати');
  for (const c of counterDocs) console.log(`   ${pad(c.seq)}  ${c.name}`);
  if (EXECUTE && counterDocs.length) {
    deleted += (await db.collection('counters').deleteMany({})).deletedCount;
  }

  // ── Користувачі: акаунти лишаються, транзакційні поля обнуляються ─────────
  const usersTotal = await count('users');
  const usersWithCart = existing.has('users')
    ? await db.collection('users').countDocuments({ 'cartState.orderItemIds.0': { $exists: true } })
    : 0;
  const usersWithHistory = existing.has('users')
    ? await db.collection('users').countDocuments({ 'history.0': { $exists: true } })
    : 0;
  console.log('\n👤 КОРИСТУВАЧІ (акаунти НЕ видаляються):');
  console.log(`   ${pad(usersTotal)}  акаунтів усього`);
  console.log(`   ${pad(usersWithCart)}  з непорожнім кошиком → очищається`);
  console.log(`   ${pad(usersWithHistory)}  з непорожньою історією → очищається`);
  if (EXECUTE && existing.has('users')) {
    const r = await db.collection('users').updateMany({}, {
      $set: { cartState: CART_DEFAULT, miniAppState: MINIAPP_DEFAULT, history: [] },
    });
    console.log(`   змінено акаунтів: ${r.modifiedCount}`);
  }

  // ── Індекси очищених колекцій ─────────────────────────────────────────────
  console.log('\n🧩 ІНДЕКСИ:');
  if (!RESET_INDEXES) {
    console.log('        —   не чіпаємо (прапорець --reset-indexes не заданий)');
  } else if (!EXECUTE) {
    console.log('        —   --reset-indexes працює лише разом з --execute');
    for (const [modelName, , name] of wiped) {
      const names = (await db.collection(name).indexes()).map((i) => i.name).filter((n) => n !== '_id_');
      console.log(`       ${modelName.padEnd(18)} ${names.length ? names.join(', ') : '(лише _id_)'}`);
    }
  } else {
    for (const [modelName, model, name] of wiped) {
      try {
        const before = (await db.collection(name).indexes()).map((i) => i.name).filter((n) => n !== '_id_');
        if (before.length) await db.collection(name).dropIndexes();
        await model.syncIndexes();
        if (name === 'shopproducts') {
          await require('../utils/ensureShopProductIndexes').ensureShopProductIndexes();
        }
        const after = (await db.collection(name).indexes()).map((i) => i.name).filter((n) => n !== '_id_');
        console.log(`   ✔ ${modelName.padEnd(18)} ${after.length ? after.join(', ') : '(лише _id_)'}`);
      } catch (err) {
        console.error(`   ✖ ${modelName.padEnd(18)} ${err.message}`);
      }
    }
    console.log('   Atlas $vectorSearch на productvectors не чіпався (колекції не дропались).');
  }

  console.log('');
  if (EXECUTE) {
    console.log(`✔ Готово. Видалено документів: ${deleted}.`);
    console.log('   Далі: перезапустити сервер (скидає кеші в пам’яті + syncIndexes на старті).');
  } else {
    console.log('ℹ️  Dry-run — нічого не записано. Повторіть з --execute, щоб застосувати.');
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
