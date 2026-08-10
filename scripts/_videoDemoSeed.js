'use strict';
/**
 * ТИМЧАСОВИЙ seed під запис відео.
 *
 * Садить продавця в «ТЕСТОВИЙ МАГАЗИН» і створює ОДНЕ замовлення, датоване
 * неділею, у сесії групи «Понеділок Достава». У замовленні 9 позицій:
 *   3 × Спаковано   (packed=true,  packedQuantity=quantity)
 *   3 × Не спаковано(packed=false, cancelled=false)
 *   3 × Закінчився  (cancelled=true)
 * Кількості — різні в кожній позиції.
 *
 * СВІДОМО НЕ робить: не архівує товари під «Закінчився» (прапорця в замовленні
 * досить для рожевого бейджа), не створює PickingTask, не чіпає каталог.
 *
 * Запуск (за замовчуванням DRY-RUN, нічого не пише):
 *   node scripts/_videoDemoSeed.js --db=prod
 *   node scripts/_videoDemoSeed.js --db=prod --execute
 *   node scripts/_videoDemoSeed.js --db=prod --cleanup --execute
 *
 * Прапорці:
 *   --db=prod|test     обов'язковий вибір кластера
 *   --execute          реально писати (без нього — тільки план)
 *   --cleanup          прибрати за собою (замовлення + повернути shopId продавця)
 *   --seller=<tgId>    telegramId продавця (типово 926546988 — Юрка Пилюк)
 *   --prices           проставити демо-ціни в позиціях замовлення
 *                      (каталог НЕ чіпається, ціна живе тільки в замовленні)
 *   --role-seller      додатково перевести акаунт у role='seller'
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');

// ── аргументи ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (name, dflt = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const DB_CHOICE = val('db');
const EXECUTE = has('--execute');
const CLEANUP = has('--cleanup');
const SELLER_TG = val('seller', '926546988');
const WITH_PRICES = has('--prices');
const FLIP_ROLE = has('--role-seller');

const ENV_FILE = { prod: '.env', test: 'arturmarkarag-db-user.env' }[DB_CHOICE];
if (!ENV_FILE) {
  console.error('⛔ Вкажіть базу: --db=prod або --db=test');
  process.exit(2);
}

function uriFrom(file, dbName) {
  const parsed = dotenv.parse(fs.readFileSync(path.join(ROOT, file)));
  const uri = parsed.MONGODB_URI;
  if (!uri) throw new Error(`MONGODB_URI не знайдено у ${file}`);
  const q = uri.indexOf('?');
  const query = q >= 0 ? uri.slice(q) : '?retryWrites=true&w=majority';
  const base = q >= 0 ? uri.slice(0, q) : uri;
  const schemeEnd = base.indexOf('://') + 3;
  const pathAt = base.indexOf('/', schemeEnd);
  return `${pathAt >= 0 ? base.slice(0, pathAt) : base}/${dbName}${query}`;
}

const URI = uriFrom(ENV_FILE, 'tg_manager');
const EXPECTED_CLUSTER = { prod: 'p5rmla3', test: 'epfky0s' }[DB_CHOICE];
if (!URI.includes(EXPECTED_CLUSTER)) {
  console.error(`⛔ --db=${DB_CHOICE} очікує кластер ${EXPECTED_CLUSTER}, а в ${ENV_FILE} інший. Стоп.`);
  process.exit(3);
}

// ── сценарій ────────────────────────────────────────────────────────────────
const MARK = '__VIDEO_DEMO__';
const SHOP_NAME_RE = /ТЕСТОВИЙ МАГАЗИН/i;
const GROUP_NAME_RE = /Понеділок/i;

// Неділя перед сьогоднішнім понеділком + година «як живе замовлення».
// Warsaw = UTC+2 влітку, тому 19:42 місцевого = 17:42Z.
const ORDER_CREATED_AT = new Date('2026-08-09T17:42:00.000Z'); // нд, 19:42 Warsaw
// Пакували в понеділок зранку, вже після закриття вікна (07:30 Warsaw).
const PACKED_AT = new Date('2026-08-10T06:15:00.000Z');        // пн, 08:15 Warsaw

// 3 стани × 3 позиції, кількості навмисне різні
const PLAN = [
  { state: 'packed',    qty: 2,  price: 12.5 },
  { state: 'packed',    qty: 5,  price: 7.0 },
  { state: 'packed',    qty: 3,  price: 24.9 },
  { state: 'pending',   qty: 4,  price: 9.9 },
  { state: 'pending',   qty: 1,  price: 34.0 },
  { state: 'pending',   qty: 7,  price: 5.5 },
  { state: 'cancelled', qty: 6,  price: 15.0 },
  { state: 'cancelled', qty: 3,  price: 8.75 },
  { state: 'cancelled', qty: 2,  price: 19.9 },
];
const STATE_LABEL = { packed: 'Спаковано', pending: 'Не спаковано', cancelled: 'Закінчився' };

const log = (...a) => console.log(...a);
const money = (n) => `${Number(n).toFixed(2)} zł`;

async function main() {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db();

  log('');
  log(`БАЗА:    ${DB_CHOICE.toUpperCase()} (${EXPECTED_CLUSTER}) · db=${db.databaseName}`);
  log(`РЕЖИМ:   ${CLEANUP ? 'CLEANUP' : 'SEED'} · ${EXECUTE ? '⚠ EXECUTE (пише в базу)' : 'DRY-RUN (нічого не пише)'}`);
  log('');

  // ── знаходимо все ─────────────────────────────────────────────────────────
  const shop = await db.collection('shops').findOne({ name: SHOP_NAME_RE });
  if (!shop) throw new Error('Магазин «ТЕСТОВИЙ МАГАЗИН» не знайдено');

  const group = await db.collection('deliverygroups').findOne({ name: GROUP_NAME_RE });
  if (!group) throw new Error('Групу «Понеділок Достава» не знайдено');
  if (String(shop.deliveryGroupId) !== String(group._id)) {
    throw new Error(`Магазин у групі ${shop.deliveryGroupId}, а не в «${group.name}» (${group._id})`);
  }

  const seller = await db.collection('users').findOne({ telegramId: String(SELLER_TG) });
  if (!seller) throw new Error(`Користувача telegramId=${SELLER_TG} не знайдено`);

  const city = shop.cityId ? await db.collection('cities').findOne({ _id: shop.cityId }) : null;
  const sellerName = [seller.firstName, seller.lastName].filter(Boolean).join(' ').trim();

  // Сесія, в чиє вікно потрапляє неділя (Сб 16:30 → Пн 07:30).
  const session = await db.collection('orderingsessions').findOne({
    groupId: String(group._id),
    openAt: { $lte: ORDER_CREATED_AT },
  }, { sort: { openAt: -1 } });
  if (!session) throw new Error('Сесію, що покриває неділю, не знайдено');

  log('ЗНАЙДЕНО');
  log(`  магазин:  «${shop.name}»  _id=${shop._id}  місто=${city ? city.name : '—'}  активний=${shop.isActive}`);
  log(`  група:    «${group.name}»  _id=${group._id}  вікно: Сб ${group.orderingSchedule.startHour}:${String(group.orderingSchedule.startMinute).padStart(2, '0')} → Пн ${group.orderingSchedule.endHour}:${String(group.orderingSchedule.endMinute).padStart(2, '0')}`);
  log(`  сесія:    ${session.openDate}  _id=${session._id}  seq=${session.seq}  picking=${session.pickingStatus}`);
  log(`  продавець:«${sellerName}»  tg=${seller.telegramId}  role=${seller.role}  поточний shopId=${seller.shopId ?? 'null'}`);
  log('');

  if (CLEANUP) return cleanup({ client, db, shop, seller, sellerName });

  // ── товари ────────────────────────────────────────────────────────────────
  const block = await db.collection('blocks').findOne({ 'productIds.0': { $exists: true } }, { sort: { blockId: 1 } });
  const candidates = await db.collection('products')
    .find({ _id: { $in: block.productIds }, status: 'active', 'imageUrls.0': { $exists: true } })
    .project({ name: 1, price: 1, orderNumber: 1, imageUrls: 1 })
    .sort({ orderNumber: 1 })
    .limit(PLAN.length)
    .toArray();
  if (candidates.length < PLAN.length) {
    throw new Error(`потрібно ${PLAN.length} активних товарів з фото, знайдено ${candidates.length}`);
  }

  // ── конфлікти ─────────────────────────────────────────────────────────────
  const idempotencyKey = `${MARK}:${shop._id}:${session._id}`;
  const dupe = await db.collection('orders').findOne({
    $or: [{ idempotencyKey }, { 'history.meta.mark': MARK }],
  });
  const activeClash = await db.collection('orders').findOne({
    buyerTelegramId: String(seller.telegramId),
    shopId: shop._id,
    orderingSessionId: String(session._id),
    status: { $in: ['new', 'in_progress'] },
  });

  const maxOrder = await db.collection('orders')
    .find({ orderNumber: { $ne: null } }).sort({ orderNumber: -1 }).limit(1)
    .project({ orderNumber: 1 }).toArray();
  const orderNumber = (maxOrder[0]?.orderNumber || 0) + 1;

  // ── збираємо документ ─────────────────────────────────────────────────────
  const items = PLAN.map((p, i) => {
    const product = candidates[i];
    const price = WITH_PRICES ? p.price : Number(product.price || 0);
    return {
      _id: new ObjectId(),
      productId: product._id,
      name: product.name || '',
      price,
      quantity: p.qty,
      packed: p.state === 'packed',
      packedQuantity: p.state === 'packed' ? p.qty : null,
      shortfallReason: null,
      // Реального складника не підставляємо: він потрапив би в аудит як автор
      // пакування, якого не було. Ім'я лишаємо загальним, id — порожнім.
      packedBy: '',
      packedByName: p.state === 'packed' ? 'Склад' : '',
      packedAt: p.state === 'packed' ? PACKED_AT : null,
      cancelled: p.state === 'cancelled',
      skipped: false,
      voided: false,
      __state: p.state,
      __num: product.orderNumber,
    };
  });

  const totalPrice = Math.round(items.reduce((s, it) => s + it.price * it.quantity, 0) * 100) / 100;

  const orderDoc = {
    _id: new ObjectId(),
    buyerTelegramId: String(seller.telegramId),
    shopId: shop._id,
    items: items.map(({ __state, __num, ...rest }) => rest),
    // 3 позиції ще не оброблені → замовлення в роботі (utils/orderStatus.js)
    status: 'in_progress',
    totalPrice,
    orderType: 'manual',
    receiptId: null,
    emojiType: '',
    shippingAddress: '',
    contactInfo: '',
    idempotencyKey,
    orderingSessionId: String(session._id),
    buyerSnapshot: {
      shopId: shop._id,
      shopName: shop.name || '',
      shopCity: city ? city.name : '',
      shopAddress: shop.address || '',
      deliveryGroupId: String(group._id),
    },
    orderNumber,
    history: [
      {
        at: ORDER_CREATED_AT, by: String(seller.telegramId), byName: sellerName, byRole: 'seller',
        action: 'created',
        meta: { mark: MARK, prevShopId: seller.shopId ? String(seller.shopId) : null, prevRole: seller.role },
      },
      {
        at: PACKED_AT, by: 'system', byName: 'video-demo-seed', byRole: 'system',
        action: 'items_packed', meta: { mark: MARK, packed: 3, cancelled: 3, pending: 3 },
      },
    ],
    createdAt: ORDER_CREATED_AT,
    updatedAt: PACKED_AT,
  };

  // ── план ──────────────────────────────────────────────────────────────────
  log('ПЛАН ЗАПИСУ');
  log('');
  log(`1) users.updateOne({ telegramId: ${seller.telegramId} })`);
  log(`     shopId: ${seller.shopId ?? 'null'}  →  ${shop._id}   («${shop.name}»)`);
  if (FLIP_ROLE) log(`     role:   ${seller.role}  →  seller        ⚠ втратить доступ адміна до відкату`);
  else log(`     role:   ${seller.role}  →  без змін`);
  log(`     + запис в history (mark: ${MARK}, prevShopId збережено для відкату)`);
  log('');
  log(`2) orders.insertOne  #${orderNumber}  _id=${orderDoc._id}`);
  log(`     buyerTelegramId: ${orderDoc.buyerTelegramId} («${sellerName}»)`);
  log(`     shopId:          ${shop._id} («${shop.name}», ${city ? city.name : '—'})`);
  log(`     група:           ${group.name}`);
  log(`     сесія:           ${session._id} (${session.openDate})`);
  log(`     createdAt:       ${ORDER_CREATED_AT.toISOString()}  →  нд, 09.08.2026 19:42 Warsaw`);
  log(`     статус:          in_progress  (3 позиції ще не оброблені)`);
  log(`     сума:            ${money(totalPrice)}${WITH_PRICES ? '  (демо-ціни, каталог не чіпаємо)' : '  (ціни з каталогу)'}`);
  log('');
  log('     позиції:');
  for (const it of items) {
    log(`       ${STATE_LABEL[it.__state].padEnd(13)} · ${String(it.quantity).padStart(2)} шт · товар #${String(it.__num).padEnd(4)} ${it.productId} · ${money(it.price)}/шт`
      + (it.__state === 'packed' ? `  → видано ${it.packedQuantity} шт` : ''));
  }
  log('');
  log(`     разом: ${items.reduce((s, i) => s + i.quantity, 0)} шт у ${items.length} позиціях`);
  log('');

  log('ЩО НЕ ЗМІНЮЄТЬСЯ');
  log('     • товари в каталозі — жоден не архівується (бейдж «Закінчився» дає прапорець у замовленні)');
  log('     • PickingTask не створюються, сесія лишається у статусі', session.pickingStatus);
  log(`     • session.seq лишається ${session.seq} (як у решти 35 замовлень цієї сесії)`);
  log('     • інші замовлення, магазини, користувачі — не торкаємось');
  log('');

  const problems = [];
  if (dupe) problems.push(`вже є замовлення з міткою ${MARK}: #${dupe.orderNumber} _id=${dupe._id} → спершу --cleanup`);
  if (activeClash) problems.push(`вже є активне замовлення цього продавця в цій сесії: #${activeClash.orderNumber} (unique-індекс one_active_order_per_buyer_shop_session кине E11000)`);
  if (problems.length) {
    log('⛔ ПЕРЕШКОДИ');
    problems.forEach((p) => log('     •', p));
    log('');
  }

  if (!EXECUTE) {
    log('DRY-RUN — у базу нічого не записано.');
    log(`Щоб застосувати: node scripts/_videoDemoSeed.js --db=${DB_CHOICE} --execute${WITH_PRICES ? ' --prices' : ''}${FLIP_ROLE ? ' --role-seller' : ''}`);
    await client.close();
    return;
  }
  if (problems.length) {
    log('Стоп: спершу приберіть перешкоди вище.');
    await client.close();
    process.exitCode = 1;
    return;
  }

  // ── запис ─────────────────────────────────────────────────────────────────
  const userSet = { shopId: shop._id };
  if (FLIP_ROLE) userSet.role = 'seller';
  await db.collection('users').updateOne(
    { _id: seller._id },
    {
      $set: userSet,
      $push: {
        history: {
          at: new Date(), by: 'system', byName: 'video-demo-seed', byRole: 'system',
          action: 'shop_assigned',
          meta: { mark: MARK, shopId: String(shop._id), prevShopId: seller.shopId ? String(seller.shopId) : null, prevRole: seller.role },
        },
      },
    },
  );
  await db.collection('shops').updateOne({ _id: shop._id }, { $set: { lastSellerChangedAt: new Date() } });
  await db.collection('orders').insertOne(orderDoc);

  log(`✅ Готово. Замовлення #${orderNumber} створено, продавця посаджено в «${shop.name}».`);
  log(`Прибрати: node scripts/_videoDemoSeed.js --db=${DB_CHOICE} --cleanup --execute`);
  await client.close();
}

async function cleanup({ client, db, shop, seller, sellerName }) {
  const orders = await db.collection('orders').find({ 'history.meta.mark': MARK }).toArray();
  log('CLEANUP');
  log(`  замовлень з міткою ${MARK}: ${orders.length}`);
  orders.forEach((o) => log(`     #${o.orderNumber} _id=${o._id} status=${o.status} items=${o.items.length}`));

  const created = orders.flatMap((o) => o.history).find((h) => h.action === 'created' && h.meta?.mark === MARK);
  const prevShopId = created?.meta?.prevShopId ?? null;
  const prevRole = created?.meta?.prevRole ?? null;
  log(`  продавець «${sellerName}»: shopId ${seller.shopId ?? 'null'} → ${prevShopId ?? 'null'}`
    + (prevRole && prevRole !== seller.role ? ` · role ${seller.role} → ${prevRole}` : ''));

  if (!EXECUTE) {
    log('');
    log('DRY-RUN — нічого не видалено.');
    await client.close();
    return;
  }

  const del = await db.collection('orders').deleteMany({ 'history.meta.mark': MARK });
  const userSet = { shopId: prevShopId ? new ObjectId(prevShopId) : null };
  if (prevRole) userSet.role = prevRole;
  await db.collection('users').updateOne(
    { _id: seller._id },
    { $set: userSet, $pull: { history: { 'meta.mark': MARK } } },
  );
  log('');
  log(`✅ Прибрано: замовлень ${del.deletedCount}, продавця повернуто.`);
  await client.close();
}

main().catch((e) => { console.error('ERR:', e.message); process.exitCode = 1; });
