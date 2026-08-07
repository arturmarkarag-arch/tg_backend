'use strict';

/**
 * supplementLastWaveSellers — READ-ONLY: хто з продавців замовив товари на
 * ОСТАННЬОМУ дозамовленні.
 *
 * «Одне дозамовлення» = одна хвиля = одна проведена накладна типу `supplement`
 * (docs/supplement/readme.md §3). Вона відкриває пропозиції (SupplementOffer)
 * рівно для однієї групи доставки; заявка магазину (SupplementRequest) зберігає
 * автора в `createdBy` — це telegramId продавця.
 *
 *   node scripts/supplementLastWaveSellers.js                  # остання хвиля (будь-яка група)
 *   node scripts/supplementLastWaveSellers.js --list           # останні 15 хвиль, щоб обрати
 *   node scripts/supplementLastWaveSellers.js --list=40
 *   node scripts/supplementLastWaveSellers.js --group=Четвер   # остання хвиля конкретної групи
 *   node scripts/supplementLastWaveSellers.js --group=66f0...  # або по ObjectId групи
 *   node scripts/supplementLastWaveSellers.js --receipt=SUP-12 # конкретна накладна (номер або _id)
 *   node scripts/supplementLastWaveSellers.js --active         # усі активні хвилі (open + frozen)
 *   node scripts/supplementLastWaveSellers.js --json           # машинний вивід
 *   node scripts/supplementLastWaveSellers.js --csv=sellers.csv
 *
 * Нічого не пише в базу.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const mongoose = require('mongoose');

const SupplementOffer   = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
const Receipt       = require('../models/Receipt');
const DeliveryGroup = require('../models/DeliveryGroup');
const Shop    = require('../models/Shop');
const User    = require('../models/User');
const Product = require('../models/Product');

// ─── Аргументи ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const optOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const OPT = {
  list:    hasFlag('list') ? (Number.parseInt(optOf('list'), 10) || 15) : 0,
  group:   optOf('group'),
  receipt: optOf('receipt'),
  active:  hasFlag('active'),
  json:    hasFlag('json'),
  csv:     optOf('csv'),
};

// ─── Форматування ────────────────────────────────────────────────────────────

const fmtDT = (d) => (d
  ? new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(d))
  : '—');

const fullName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();
const plural = (n, one, few, many) => {
  const m10 = Math.abs(n) % 10;
  const m100 = Math.abs(n) % 100;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
};

// ─── Пошук хвилі ─────────────────────────────────────────────────────────────

/** Останні хвилі: групуємо пропозиції по накладній. */
async function listWaves(limit, match = {}) {
  return SupplementOffer.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$receiptId',
        deliveryGroupId: { $first: '$deliveryGroupId' },
        openedAt: { $max: '$openedAt' },
        createdAt: { $max: '$createdAt' },
        offers: { $sum: 1 },
        open:      { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
        frozen:    { $sum: { $cond: [{ $eq: ['$status', 'frozen'] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
      },
    },
    { $sort: { openedAt: -1, createdAt: -1 } },
    ...(limit ? [{ $limit: limit }] : []),
  ]);
}

/** Група за _id або за назвою (без урахування регістру). */
async function resolveGroup(raw) {
  const val = String(raw || '').trim();
  if (!val) return null;
  if (mongoose.Types.ObjectId.isValid(val)) {
    const byId = await DeliveryGroup.findById(val, 'name dayOfWeek').lean();
    if (byId) return byId;
  }
  const byName = await DeliveryGroup.find(
    { name: new RegExp(`^${val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    'name dayOfWeek',
  ).lean();
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`Назва групи «${val}» неоднозначна: знайдено ${byName.length}`);
  return null;
}

/** Накладна за receiptNumber або _id. */
async function resolveReceipt(raw) {
  const val = String(raw || '').trim();
  if (mongoose.Types.ObjectId.isValid(val)) {
    const byId = await Receipt.findById(val).lean();
    if (byId) return byId;
  }
  return Receipt.findOne({ receiptNumber: val }).lean();
}

/** Які хвилі показувати за поточними опціями. @returns {Promise<string[]>} receiptId[] */
async function pickWaves() {
  if (OPT.receipt) {
    const receipt = await resolveReceipt(OPT.receipt);
    if (!receipt) throw new Error(`Накладну «${OPT.receipt}» не знайдено`);
    return [String(receipt._id)];
  }

  if (OPT.active) {
    const waves = await listWaves(0, { status: { $in: SupplementOffer.ACTIVE_STATUSES } });
    return waves.map((w) => String(w._id));
  }

  const match = {};
  if (OPT.group) {
    const group = await resolveGroup(OPT.group);
    if (!group) throw new Error(`Групу доставки «${OPT.group}» не знайдено`);
    match.deliveryGroupId = String(group._id);
  }
  const waves = await listWaves(1, match);
  return waves.map((w) => String(w._id));
}

// ─── Збір даних однієї хвилі ─────────────────────────────────────────────────

async function collectWave(receiptId) {
  const offers = await SupplementOffer.find({ receiptId }).sort({ createdAt: 1 }).lean();
  if (!offers.length) return null;

  const [receipt, group] = await Promise.all([
    Receipt.findById(receiptId, 'receiptNumber completedAt supplementOpenedAt createdBy status').lean(),
    DeliveryGroup.findById(offers[0].deliveryGroupId, 'name dayOfWeek').lean(),
  ]);

  const requests = await SupplementRequest
    .find({ offerId: { $in: offers.map((o) => o._id) } })
    .sort({ createdAt: 1 })
    .lean();

  const products = await Product.find(
    { _id: { $in: offers.map((o) => o.productId) } },
    'name brand model barcode',
  ).lean();
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const offerById = new Map(offers.map((o) => [String(o._id), o]));

  // Магазини: і ті, що замовили, і всі активні магазини групи (для «не замовили»).
  const groupId = String(offers[0].deliveryGroupId);
  const shops = await Shop.find(
    { $or: [{ _id: { $in: requests.map((r) => r.shopId) } }, { deliveryGroupId: groupId, isActive: true }] },
    'name deliveryGroupId isActive',
  ).lean();
  const shopById = new Map(shops.map((s) => [String(s._id), s]));

  // Продавці: автори заявок + усі приписані до магазинів групи.
  const authorIds = [...new Set(requests.flatMap((r) => [r.createdBy, r.updatedBy]).filter(Boolean).map(String))];
  const users = await User.find(
    { $or: [{ telegramId: { $in: authorIds } }, { shopId: { $in: shops.map((s) => s._id) } }] },
    'telegramId role firstName lastName shopId botBlocked lastActive',
  ).lean();
  const userByTgId = new Map(users.map((u) => [String(u.telegramId), u]));

  const productLabel = (offer) => {
    const p = productById.get(String(offer.productId));
    if (!p) return `товар ${String(offer.productId)} (видалений?)`;
    return p.name || [p.brand, p.model].filter(Boolean).join(' ') || p.barcode || String(p._id);
  };

  // ── Групування по продавцях (createdBy = автор заявки) ──────────────────────
  const sellers = new Map();
  for (const r of requests) {
    const key = String(r.createdBy || '') || `anon:${String(r.shopId)}`;
    if (!sellers.has(key)) {
      const u = userByTgId.get(String(r.createdBy || ''));
      sellers.set(key, {
        telegramId: String(r.createdBy || ''),
        name: fullName(u) || r.createdByName || '(ім’я невідоме)',
        role: u?.role || '—',
        accountExists: Boolean(u),
        botBlocked: Boolean(u?.botBlocked),
        shops: new Set(),
        items: [],
        totalQty: 0,
        packedQty: 0,
        firstAt: r.createdAt,
        lastAt: r.updatedAt || r.createdAt,
      });
    }
    const s = sellers.get(key);
    const offer = offerById.get(String(r.offerId));
    const shop = shopById.get(String(r.shopId));

    s.shops.add(shop?.name || r.shopName || String(r.shopId));
    s.items.push({
      product: offer ? productLabel(offer) : `пропозиція ${String(r.offerId)}`,
      productId: offer ? String(offer.productId) : '',
      shopName: shop?.name || r.shopName || String(r.shopId),
      quantity: r.quantity,
      packed: Boolean(r.packed),
      packedByName: r.packedByName || '',
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      updatedBy: String(r.updatedBy || ''),
      updatedByName: r.updatedByName || '',
      offerStatus: offer?.status || '—',
    });
    s.totalQty += r.quantity || 0;
    if (r.packed) s.packedQty += r.quantity || 0;
    if (r.createdAt < s.firstAt) s.firstAt = r.createdAt;
    const touched = r.updatedAt || r.createdAt;
    if (touched > s.lastAt) s.lastAt = touched;
  }

  // ── Магазини групи, які нічого не замовили ────────────────────────────────
  const orderedShopIds = new Set(requests.map((r) => String(r.shopId)));
  const silentShops = shops
    .filter((s) => s.isActive && String(s.deliveryGroupId) === groupId && !orderedShopIds.has(String(s._id)))
    .map((s) => ({
      shopId: String(s._id),
      name: s.name,
      sellers: users
        .filter((u) => String(u.shopId || '') === String(s._id))
        .map((u) => ({
          telegramId: String(u.telegramId),
          name: fullName(u) || '(ім’я невідоме)',
          role: u.role,
          botBlocked: Boolean(u.botBlocked),
        })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'uk'));

  return {
    receiptId: String(receiptId),
    receiptNumber: receipt?.receiptNumber || '(накладну видалено)',
    openedAt: offers[0].openedAt || receipt?.supplementOpenedAt || receipt?.completedAt || null,
    group: {
      deliveryGroupId: groupId,
      name: group?.name || '(групу видалено)',
      dayOfWeek: group?.dayOfWeek ?? null,
    },
    offers: {
      total: offers.length,
      open: offers.filter((o) => o.status === 'open').length,
      frozen: offers.filter((o) => o.status === 'frozen').length,
      completed: offers.filter((o) => o.status === 'completed').length,
      products: offers.map((o) => ({ productId: String(o.productId), name: productLabel(o), status: o.status })),
    },
    sellers: [...sellers.values()]
      .map((s) => ({ ...s, shops: [...s.shops] }))
      .sort((a, b) => b.totalQty - a.totalQty || a.name.localeCompare(b.name, 'uk')),
    requestCount: requests.length,
    shopCount: orderedShopIds.size,
    silentShops,
  };
}

// ─── Вивід ───────────────────────────────────────────────────────────────────

function printWave(w) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📦 ХВИЛЯ ДОЗАМОВЛЕННЯ — накладна ${w.receiptNumber}`);
  console.log(`   відкрита: ${fmtDT(w.openedAt)}   група: ${w.group.name}   (${w.group.deliveryGroupId})`);
  console.log(`   пропозицій: ${w.offers.total}  [open ${w.offers.open} / frozen ${w.offers.frozen} / completed ${w.offers.completed}]`);
  console.log(`   товари: ${w.offers.products.map((p) => p.name).join(', ') || '—'}`);

  const totalQty = w.sellers.reduce((sum, s) => sum + s.totalQty, 0);
  console.log(`\n🛒 ЗАМОВИЛИ: ${w.sellers.length} ${plural(w.sellers.length, 'продавець', 'продавці', 'продавців')}`
    + ` · ${w.shopCount} ${plural(w.shopCount, 'магазин', 'магазини', 'магазинів')}`
    + ` · ${w.requestCount} ${plural(w.requestCount, 'заявка', 'заявки', 'заявок')}`
    + ` · ${totalQty} шт`);

  if (!w.sellers.length) {
    console.log('   —  на цій хвилі не замовив ніхто');
  }

  for (const s of w.sellers) {
    const warn = [
      !s.accountExists ? 'акаунт видалено' : null,
      s.botBlocked ? 'бот заблокований' : null,
      s.role !== 'seller' && s.accountExists ? `роль: ${s.role}` : null,
    ].filter(Boolean);
    console.log(`\n   👤 ${s.name}   tg ${s.telegramId || '—'}${warn.length ? `   ⚠️ ${warn.join(', ')}` : ''}`);
    console.log(`      магазин: ${s.shops.join(', ')}`);
    console.log(`      позицій: ${s.items.length}   штук: ${s.totalQty}   спаковано: ${s.packedQty}/${s.totalQty}`);
    console.log(`      перша заявка: ${fmtDT(s.firstAt)}   остання зміна: ${fmtDT(s.lastAt)}`);
    for (const it of s.items) {
      const marks = [
        it.packed ? `спаковано${it.packedByName ? ` (${it.packedByName})` : ''}` : 'не спаковано',
        it.updatedBy && it.updatedBy !== s.telegramId ? `змінив ${it.updatedByName || it.updatedBy}` : null,
      ].filter(Boolean);
      console.log(`        • ${it.product} — ${it.quantity} шт   [${marks.join(' · ')}]`);
    }
  }

  if (w.silentShops.length) {
    console.log(`\n🔕 НЕ ЗАМОВИЛИ (активні магазини групи): ${w.silentShops.length}`);
    for (const s of w.silentShops) {
      const who = s.sellers.length
        ? s.sellers.map((u) => `${u.name} tg ${u.telegramId}${u.botBlocked ? ' ⚠️бот заблокований' : ''}`).join('; ')
        : '— продавця не призначено';
      console.log(`   • ${s.name}: ${who}`);
    }
  }
}

function toCsv(waves) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [[
    'накладна', 'група', 'відкрита', 'telegramId', 'продавець', 'роль',
    'магазин', 'товар', 'кількість', 'спаковано', 'створено', 'останнязміна', 'змінив',
  ]];
  for (const w of waves) {
    for (const s of w.sellers) {
      for (const it of s.items) {
        rows.push([
          w.receiptNumber, w.group.name, fmtDT(w.openedAt),
          s.telegramId, s.name, s.role,
          it.shopName, it.product, it.quantity, it.packed ? 'так' : 'ні',
          fmtDT(it.createdAt), fmtDT(it.updatedAt),
          it.updatedBy && it.updatedBy !== s.telegramId ? (it.updatedByName || it.updatedBy) : '',
        ]);
      }
    }
  }
  // BOM — щоб Excel на Windows не ламав кирилицю.
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  if (!OPT.json) {
    console.log(`\n🔍 READ-ONLY: продавці останнього дозамовлення`);
    console.log(`   база: ${db.databaseName}   host: ${mongoose.connection.host}`);
  }

  // --list: показати останні хвилі й вийти.
  if (OPT.list) {
    const waves = await listWaves(OPT.list);
    const receipts = await Receipt.find(
      { _id: { $in: waves.map((w) => w._id) } }, 'receiptNumber',
    ).lean();
    const numberById = new Map(receipts.map((r) => [String(r._id), r.receiptNumber]));
    const groups = await DeliveryGroup.find({}, 'name').lean();
    const groupName = new Map(groups.map((g) => [String(g._id), g.name]));

    console.log(`\n📜 ОСТАННІ ХВИЛІ ДОЗАМОВЛЕНЬ (${waves.length}):`);
    for (const w of waves) {
      console.log(`   ${fmtDT(w.openedAt || w.createdAt)}  накладна ${numberById.get(String(w._id)) || String(w._id)}`
        + `  група ${groupName.get(String(w.deliveryGroupId)) || w.deliveryGroupId}`
        + `  пропозицій ${w.offers} [open ${w.open}/frozen ${w.frozen}/completed ${w.completed}]`);
    }
    console.log('\n   Деталі конкретної: --receipt=<номер накладної>');
    await mongoose.disconnect();
    return;
  }

  const receiptIds = await pickWaves();
  if (!receiptIds.length) {
    console.log('\n   Хвиль дозамовлення не знайдено (жодної пропозиції в базі за цим фільтром).');
    await mongoose.disconnect();
    return;
  }

  const waves = [];
  for (const id of receiptIds) {
    const wave = await collectWave(id);
    if (wave) waves.push(wave);
  }

  if (OPT.json) {
    console.log(JSON.stringify(waves, null, 2));
  } else {
    for (const w of waves) printWave(w);
    console.log('');
  }

  if (OPT.csv) {
    fs.writeFileSync(OPT.csv, toCsv(waves), 'utf8');
    if (!OPT.json) console.log(`💾 CSV збережено: ${OPT.csv}\n`);
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
