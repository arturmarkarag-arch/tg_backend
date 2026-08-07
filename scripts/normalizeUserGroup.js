'use strict';

/**
 * normalizeUserGroup — знімає денормалізовані User.deliveryGroupId / User.warehouseZone.
 *
 * ЄДИНЕ джерело групи доставки:  User.shopId → Shop.deliveryGroupId → DeliveryGroup
 * Копії на User більше не пише жоден шлях (див. models/User.js), тож поля в
 * документах — просто вага, яка ще й вводить в оману при читанні бази вручну.
 *
 * ПОРЯДОК ЗАПУСКУ ОБОВʼЯЗКОВИЙ:
 *   1) спочатку деплой коду, який читає групу з магазину;
 *   2) тільки потім `--execute`.
 * Навпаки — не можна: старий код на проді читав би вже стерті поля (фільтр
 * «Користувачі → група» повернув би порожньо).
 *
 * Чому нативний драйвер, а не Mongoose: strict-mode ТИХО викидає з $unset поля,
 * яких немає в схемі, і рапортує modifiedCount без жодної зміни в базі.
 * Тому і запис, і перевірка йдуть через .collection.
 *
 *   node scripts/normalizeUserGroup.js              # dry-run (нічого не пише)
 *   node scripts/normalizeUserGroup.js --execute    # зняти поля
 *   node scripts/normalizeUserGroup.js --verify     # тільки перевірка стану
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const VERIFY_ONLY = argv.includes('--verify');

const log = (s = '') => console.log(s);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const users = db.collection('users');
  const shops = db.collection('shops');
  const groups = db.collection('deliverygroups');

  log(`База: ${db.databaseName}`);
  log(`Режим: ${VERIFY_ONLY ? 'VERIFY' : EXECUTE ? 'EXECUTE (пише в базу)' : 'DRY-RUN'}`);
  log('');

  const groupById = new Map((await groups.find({}).toArray()).map((g) => [String(g._id), g]));
  const shopById = new Map((await shops.find({}).toArray()).map((s) => [String(s._id), s]));

  const all = await users.find({}, { projection: {
    telegramId: 1, role: 1, firstName: 1, lastName: 1, shopId: 1,
    deliveryGroupId: 1, warehouseZone: 1,
  } }).toArray();

  // ── Звірка ДО зняття: чи не втратимо ми десь інформацію, якої немає на магазині
  const mismatch = [];   // user ≠ shop — обидва задані
  const orphanGroup = []; // user має групу, а магазину/групи немає
  const zoneMismatch = [];
  let withField = 0;

  for (const u of all) {
    const uG = u.deliveryGroupId ? String(u.deliveryGroupId) : '';
    const uZ = u.warehouseZone || '';
    if (u.deliveryGroupId !== undefined || u.warehouseZone !== undefined) withField += 1;

    const shop = u.shopId ? shopById.get(String(u.shopId)) : null;
    const sG = shop?.deliveryGroupId ? String(shop.deliveryGroupId) : '';
    const sZ = sG ? (groupById.get(sG)?.name || '') : '';
    const name = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.telegramId;

    if (uG && sG && uG !== sG) mismatch.push({ name, role: u.role, uG, sG, shop: shop?.name || '' });
    else if (uG && !sG) orphanGroup.push({ name, role: u.role, uG, hasShop: Boolean(shop) });
    if (uZ !== sZ) zoneMismatch.push({ name, role: u.role, uZ, sZ });
  }

  log(`Користувачів: ${all.length}; з полями в документі: ${withField}`);
  log(`Розбіжність deliveryGroupId (user ≠ shop): ${mismatch.length}`);
  log(`Група на user, якої немає на магазині:     ${orphanGroup.length}`);
  log(`Розбіжність warehouseZone:                 ${zoneMismatch.length}`);
  log('');

  for (const m of mismatch.slice(0, 40)) {
    log(`  ✗ ${m.role} ${m.name} (магазин "${m.shop}"): user=${groupById.get(m.uG)?.name || m.uG} ≠ shop=${groupById.get(m.sG)?.name || m.sG}`);
  }
  for (const o of orphanGroup.slice(0, 40)) {
    log(`  ! ${o.role} ${o.name}: група ${groupById.get(o.uG)?.name || o.uG} лише на user (магазин ${o.hasShop ? 'без групи' : 'відсутній'})`);
  }
  for (const z of zoneMismatch.slice(0, 40)) {
    log(`  ~ ${z.role} ${z.name}: zone="${z.uZ}" → з магазину "${z.sZ}"`);
  }
  if (mismatch.length || orphanGroup.length || zoneMismatch.length) log('');

  const blocking = mismatch.length + orphanGroup.length;
  if (blocking > 0) {
    log(`СТОП: ${blocking} записів, де user знає про групу більше, ніж магазин.`);
    log('Спочатку розібратися з ними вручну (виправити Shop.deliveryGroupId або зняти');
    log('користувача з магазину), і лише потім знімати поля.');
    if (EXECUTE) { await mongoose.disconnect(); process.exitCode = 1; return; }
  }
  // zoneMismatch НЕ блокує: warehouseZone — це просто назва групи, вона
  // перераховується з магазину на кожному читанні.

  if (VERIFY_ONLY || !EXECUTE) {
    if (!VERIFY_ONLY) {
      log(`DRY-RUN: до зняття полів — ${withField} документів. Запуск із --execute зробить $unset.`);
    }
    const left = await users.countDocuments({ $or: [
      { deliveryGroupId: { $exists: true } }, { warehouseZone: { $exists: true } },
    ] });
    log(`Зараз у базі документів із цими полями: ${left}`);
    await mongoose.disconnect();
    return;
  }

  // ── Зняття. Нативний драйвер — Mongoose тут тихо нічого б не зробив.
  const res = await users.updateMany(
    { $or: [{ deliveryGroupId: { $exists: true } }, { warehouseZone: { $exists: true } }] },
    { $unset: { deliveryGroupId: '', warehouseZone: '' } },
  );
  log(`$unset: matched=${res.matchedCount} modified=${res.modifiedCount}`);

  // Перевірка з primary — не з репліки, щоб не побачити доунсет-стан.
  const left = await db.collection('users').countDocuments(
    { $or: [{ deliveryGroupId: { $exists: true } }, { warehouseZone: { $exists: true } }] },
    { readPreference: 'primary' },
  );
  log(`Залишилось документів із полями: ${left}`);
  log(left === 0 ? '✓ Готово.' : '✗ Поля лишились — перевірити права/фільтр.');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('ПОМИЛКА:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
