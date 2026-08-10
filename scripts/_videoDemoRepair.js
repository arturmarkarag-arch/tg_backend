'use strict';
/**
 * Ремонт демо-сіду після того, як live-переїзд продавця (migrateSellerShop)
 * потягнув демо-замовлення за собою на чужий магазин і в ЧУЖУ живу сесію.
 *
 * Повертає замовлення з міткою __VIDEO_DEMO__ на ТЕСТОВИЙ МАГАЗИН + у сесію
 * групи «Понеділок Достава», і садить продавця назад у той самий магазин.
 * Пише напряму в базу, тому жодна сервісна логіка (і жоден повторний переїзд)
 * не запускається.
 *
 *   node scripts/_videoDemoRepair.js --db=prod
 *   node scripts/_videoDemoRepair.js --db=prod --execute
 *
 * --freeze  додатково переводить замовлення у status='confirmed' (термінальний),
 *           після чого migrateSellerShop його більше НІКОЛИ не забере:
 *           activeOrderShopFilter шукає лише new/in_progress.
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (n, d = null) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };

const DB_CHOICE = val('db');
const EXECUTE = has('--execute');
const FREEZE = has('--freeze');
const ENV_FILE = { prod: '.env', test: 'arturmarkarag-db-user.env' }[DB_CHOICE];
if (!ENV_FILE) { console.error('⛔ Вкажіть базу: --db=prod або --db=test'); process.exit(2); }

function uriFrom(file, dbName) {
  const parsed = dotenv.parse(fs.readFileSync(path.join(ROOT, file)));
  const uri = parsed.MONGODB_URI;
  const q = uri.indexOf('?');
  const query = q >= 0 ? uri.slice(q) : '?retryWrites=true&w=majority';
  const base = q >= 0 ? uri.slice(0, q) : uri;
  const schemeEnd = base.indexOf('://') + 3;
  const pathAt = base.indexOf('/', schemeEnd);
  return `${pathAt >= 0 ? base.slice(0, pathAt) : base}/${dbName}${query}`;
}

const URI = uriFrom(ENV_FILE, 'tg_manager');
const EXPECTED = { prod: 'p5rmla3', test: 'epfky0s' }[DB_CHOICE];
if (!URI.includes(EXPECTED)) { console.error(`⛔ --db=${DB_CHOICE} очікує кластер ${EXPECTED}. Стоп.`); process.exit(3); }

const MARK = '__VIDEO_DEMO__';
const log = (...a) => console.log(...a);

(async () => {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db();

  log('');
  log(`БАЗА:  ${DB_CHOICE.toUpperCase()} (${EXPECTED})`);
  log(`РЕЖИМ: ${EXECUTE ? '⚠ EXECUTE (пише в базу)' : 'DRY-RUN (нічого не пише)'}${FREEZE ? ' · --freeze' : ''}`);
  log('');

  const order = await db.collection('orders').findOne({ 'history.meta.mark': MARK });
  if (!order) throw new Error(`Замовлення з міткою ${MARK} не знайдено`);

  const shop = await db.collection('shops').findOne({ name: /ТЕСТОВИЙ МАГАЗИН/i });
  const group = await db.collection('deliverygroups').findOne({ name: /Понеділок/i });
  const city = shop.cityId ? await db.collection('cities').findOne({ _id: shop.cityId }) : null;
  const seller = await db.collection('users').findOne({ telegramId: order.buyerTelegramId });

  // Сесія Понеділка, у чиє вікно потрапляє createdAt замовлення
  const targetSession = await db.collection('orderingsessions').findOne(
    { groupId: String(group._id), openAt: { $lte: order.createdAt } },
    { sort: { openAt: -1 } },
  );

  const curShop = order.shopId ? await db.collection('shops').findOne({ _id: order.shopId }) : null;
  const curSession = order.orderingSessionId
    ? await db.collection('orderingsessions').findOne({ _id: new ObjectId(order.orderingSessionId) })
    : null;
  const curGroup = curSession ? await db.collection('deliverygroups').findOne({ _id: new ObjectId(curSession.groupId) }) : null;

  log('ЗАРАЗ (після live-переїзду)');
  log(`  замовлення #${order.orderNumber}  _id=${order._id}  status=${order.status}`);
  log(`  магазин:  «${curShop ? curShop.name : '—'}»  (${order.shopId})`);
  log(`  група:    «${curGroup ? curGroup.name : '—'}»`);
  log(`  сесія:    ${curSession ? curSession.openDate : '—'}  _id=${order.orderingSessionId}  picking=${curSession ? curSession.pickingStatus : '—'}`);
  if (curSession) {
    const n = await db.collection('orders').countDocuments({ orderingSessionId: String(curSession._id) });
    const units = order.items.reduce((s, i) => s + i.quantity, 0);
    log(`     ⚠ це ЖИВА сесія: ${n} замовлень, вікно ${curSession.openAt && curSession.openAt.toISOString()} → ${curSession.closeAt && curSession.closeAt.toISOString()}`);
    log(`     ⚠ фейкових одиниць у плані збирання: ${units}`);
  }
  log(`  продавець: «${[seller.firstName, seller.lastName].filter(Boolean).join(' ')}» shopId=${seller.shopId}`);
  log('');

  log('ПОВЕРТАЮ');
  log(`  order.shopId:            ${order.shopId}  →  ${shop._id}   («${shop.name}»)`);
  log(`  order.orderingSessionId: ${order.orderingSessionId}  →  ${targetSession._id}  (${targetSession.openDate}, «${group.name}»)`);
  log(`  order.buyerSnapshot:     «${order.buyerSnapshot?.shopName}» / ${order.buyerSnapshot?.deliveryGroupId}`);
  log(`                        →  «${shop.name}» / ${group._id} (${city ? city.name : '—'})`);
  log(`  order.status:            ${order.status}  →  ${FREEZE ? 'confirmed  (термінальний — переїзди більше не заберуть)' : `${order.status}  (БЕЗ ЗМІН — лишається вразливим до наступного переїзду)`}`);
  log(`  user.shopId:             ${seller.shopId}  →  ${shop._id}`);
  log(`  + запис у history: demo_repair`);
  log('');
  log('НЕ ЧІПАЮ: інші 34 замовлення сесії Вівторка, магазин «Неруди», каталог, PickingTask.');
  log('');

  if (!EXECUTE) {
    log('DRY-RUN — нічого не записано.');
    log(`Застосувати: node scripts/_videoDemoRepair.js --db=${DB_CHOICE} --execute${FREEZE ? ' --freeze' : ''}`);
    await client.close();
    return;
  }

  const set = {
    shopId: shop._id,
    orderingSessionId: String(targetSession._id),
    'buyerSnapshot.shopId': shop._id,
    'buyerSnapshot.shopName': shop.name || '',
    'buyerSnapshot.shopCity': city ? city.name : '',
    'buyerSnapshot.shopAddress': shop.address || '',
    'buyerSnapshot.deliveryGroupId': String(group._id),
  };
  if (FREEZE) set.status = 'confirmed';

  await db.collection('orders').updateOne(
    { _id: order._id },
    {
      $set: set,
      $push: {
        history: {
          at: new Date(), by: 'system', byName: 'video-demo-repair', byRole: 'system',
          action: 'demo_repair',
          meta: {
            mark: MARK,
            undid: 'shop_reassigned',
            fromShop: curShop ? curShop.name : '',
            fromSession: String(order.orderingSessionId),
            frozen: FREEZE,
          },
        },
      },
    },
  );
  await db.collection('users').updateOne({ _id: seller._id }, { $set: { shopId: shop._id } });

  log(`✅ Повернуто: #${order.orderNumber} → «${shop.name}», сесія ${targetSession.openDate}${FREEZE ? ', статус confirmed' : ''}.`);
  await client.close();
})().catch((e) => { console.error('ERR:', e.message); process.exitCode = 1; });
