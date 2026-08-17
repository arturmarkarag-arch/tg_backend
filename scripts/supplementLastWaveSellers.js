'use strict';

/**
 * supplementLastWaveSellers — READ-ONLY diagnostics for supplement history.
 *
 * V48.S2 vocabulary:
 *   SupplementWave   = one publication to one DeliveryGroup + OrderingSession.
 *   SupplementOffer  = one item inside the Wave (legacy rows may have no waveId).
 *   SupplementRequest= one Shop request for one item.
 *
 * Modern Wave rows are preferred. Old receipt-grouped rows remain readable as
 * a legacy fallback so historical production data is not made invisible.
 *
 * Examples:
 *   node scripts/supplementLastWaveSellers.js
 *   node scripts/supplementLastWaveSellers.js --list=20
 *   node scripts/supplementLastWaveSellers.js --group=Четвер
 *   node scripts/supplementLastWaveSellers.js --wave=<ObjectId>
 *   node scripts/supplementLastWaveSellers.js --receipt=<number-or-id>
 *   node scripts/supplementLastWaveSellers.js --active
 *   node scripts/supplementLastWaveSellers.js --json
 *   node scripts/supplementLastWaveSellers.js --csv=sellers.csv
 *
 * This script performs no writes.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const mongoose = require('mongoose');

const SupplementWave = require('../models/SupplementWave');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
const Receipt = require('../models/Receipt');
const DeliveryGroup = require('../models/DeliveryGroup');
const Shop = require('../models/Shop');
const User = require('../models/User');
const Product = require('../models/Product');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const optOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const OPT = {
  list: hasFlag('list') ? (Number.parseInt(optOf('list'), 10) || 15) : 0,
  group: optOf('group'),
  wave: optOf('wave'),
  receipt: optOf('receipt'),
  active: hasFlag('active'),
  json: hasFlag('json'),
  csv: optOf('csv'),
};

const str = (v) => (v == null ? '' : String(v));
const fmtDT = (d) => (d
  ? new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(d))
  : '—');
const fullName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();

async function resolveGroup(raw) {
  const val = str(raw).trim();
  if (!val) return null;
  if (mongoose.Types.ObjectId.isValid(val)) {
    const byId = await DeliveryGroup.findById(val, 'name dayOfWeek').lean();
    if (byId) return byId;
  }
  const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rows = await DeliveryGroup.find({ name: new RegExp(`^${escaped}$`, 'i') }, 'name dayOfWeek').lean();
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) throw new Error(`Назва групи «${val}» неоднозначна: знайдено ${rows.length}`);
  return null;
}

async function resolveReceipt(raw) {
  const val = str(raw).trim();
  if (!val) return null;
  if (mongoose.Types.ObjectId.isValid(val)) {
    const byId = await Receipt.findById(val, 'receiptNumber').lean();
    if (byId) return byId;
  }
  return Receipt.findOne({ receiptNumber: val }, 'receiptNumber').lean();
}

async function modernWaveFilter() {
  const filter = {};
  if (OPT.wave) {
    if (!mongoose.Types.ObjectId.isValid(OPT.wave)) throw new Error('Некоректний --wave ObjectId');
    filter._id = OPT.wave;
  }
  if (OPT.active) filter.status = { $in: SupplementWave.ACTIVE_STATUSES };
  if (OPT.group) {
    const group = await resolveGroup(OPT.group);
    if (!group) throw new Error(`Групу доставки «${OPT.group}» не знайдено`);
    filter.deliveryGroupId = str(group._id);
  }
  if (OPT.receipt) {
    const receipt = await resolveReceipt(OPT.receipt);
    if (!receipt) throw new Error(`Накладну «${OPT.receipt}» не знайдено`);
    const waveIds = await SupplementOffer.distinct('waveId', { receiptId: receipt._id, waveId: { $ne: null } });
    filter._id = { $in: waveIds };
  }
  return filter;
}

async function listModernWaves(limit = 15) {
  const filter = await modernWaveFilter();
  return SupplementWave.find(filter)
    .sort({ openedAt: -1, createdAt: -1 })
    .limit(limit || 0)
    .lean();
}

async function listLegacyWaves(limit = 15) {
  const match = { waveId: null };
  if (OPT.active) match.status = { $in: SupplementOffer.ACTIVE_STATUSES };
  if (OPT.group) {
    const group = await resolveGroup(OPT.group);
    if (!group) throw new Error(`Групу доставки «${OPT.group}» не знайдено`);
    match.deliveryGroupId = str(group._id);
  }
  if (OPT.receipt) {
    const receipt = await resolveReceipt(OPT.receipt);
    if (!receipt) throw new Error(`Накладну «${OPT.receipt}» не знайдено`);
    match.receiptId = receipt._id;
  }
  return SupplementOffer.aggregate([
    { $match: match },
    { $group: {
      _id: '$receiptId',
      deliveryGroupId: { $first: '$deliveryGroupId' },
      openedAt: { $max: '$openedAt' },
      createdAt: { $max: '$createdAt' },
      itemCount: { $sum: 1 },
    } },
    { $sort: { openedAt: -1, createdAt: -1 } },
    ...(limit ? [{ $limit: limit }] : []),
  ]);
}

function productLabel(offer, productById) {
  if (offer.productId) {
    const p = productById.get(str(offer.productId));
    if (p) return p.name || [p.brand, p.model].filter(Boolean).join(' ') || p.barcode || str(p._id);
  }
  return offer.sourceSnapshot?.title || `позиція накладної ${str(offer.receiptItemId)}`;
}

async function collect({ wave = null, legacyReceiptId = null }) {
  const offerFilter = wave
    ? { waveId: wave._id }
    : { receiptId: legacyReceiptId, waveId: null };
  const offers = await SupplementOffer.find(offerFilter).sort({ createdAt: 1 }).lean();
  if (!offers.length) return null;

  const groupId = str(wave?.deliveryGroupId || offers[0].deliveryGroupId);
  const [group, requests] = await Promise.all([
    DeliveryGroup.findById(groupId, 'name dayOfWeek').lean(),
    SupplementRequest.find({ offerId: { $in: offers.map((o) => o._id) } }).sort({ createdAt: 1 }).lean(),
  ]);

  const productIds = offers.map((o) => o.productId).filter(Boolean);
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } }, 'name brand model barcode').lean()
    : [];
  const productById = new Map(products.map((p) => [str(p._id), p]));
  const offerById = new Map(offers.map((o) => [str(o._id), o]));

  const requestShopIds = [...new Set(requests.map((r) => str(r.shopId)).filter(Boolean))];
  const shops = await Shop.find(
    { $or: [{ _id: { $in: requestShopIds } }, { deliveryGroupId: groupId, isActive: true }] },
    'name deliveryGroupId isActive',
  ).lean();
  const shopById = new Map(shops.map((shop) => [str(shop._id), shop]));

  const actorIds = [...new Set(requests.flatMap((r) => [r.createdBy, r.updatedBy, r.packedBy]).filter(Boolean).map(str))];
  const users = await User.find(
    { $or: [{ telegramId: { $in: actorIds } }, { shopId: { $in: shops.map((s) => s._id) } }] },
    'telegramId role firstName lastName shopId botBlocked',
  ).lean();
  const userByTg = new Map(users.map((u) => [str(u.telegramId), u]));

  const sellers = new Map();
  for (const request of requests) {
    const key = str(request.createdBy) || `shop:${str(request.shopId)}`;
    if (!sellers.has(key)) {
      const u = userByTg.get(str(request.createdBy));
      sellers.set(key, {
        telegramId: str(request.createdBy),
        name: fullName(u) || request.createdByName || '(ім’я невідоме)',
        role: u?.role || '—',
        shops: new Set(),
        items: [],
        totalQty: 0,
        packedQty: 0,
      });
    }
    const row = sellers.get(key);
    const offer = offerById.get(str(request.offerId));
    const shop = shopById.get(str(request.shopId));
    row.shops.add(shop?.name || request.shopName || str(request.shopId));
    row.items.push({
      product: offer ? productLabel(offer, productById) : str(request.offerId),
      shopName: shop?.name || request.shopName || str(request.shopId),
      quantity: Number(request.quantity || 0),
      status: request.status || 'active',
      packed: Boolean(request.packed),
      packedByName: request.packedByName || fullName(userByTg.get(str(request.packedBy))) || '',
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    });
    row.totalQty += Number(request.quantity || 0);
    if (request.packed) row.packedQty += Number(request.quantity || 0);
  }

  return {
    kind: wave ? 'wave' : 'legacy_receipt_wave',
    waveId: wave ? str(wave._id) : null,
    orderingSessionId: wave ? str(wave.orderingSessionId) : null,
    status: wave?.status || null,
    openedAt: wave?.openedAt || offers[0]?.openedAt || null,
    deliveryGroupId: groupId,
    groupName: group?.name || '(групу видалено)',
    itemCount: offers.length,
    requestCount: requests.length,
    sellers: [...sellers.values()].map((row) => ({ ...row, shops: [...row.shops] })),
  };
}

function printWave(row) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📦 ${row.kind === 'wave' ? 'SUPPLEMENT WAVE' : 'LEGACY ДОЗАМОВЛЕННЯ'}`);
  console.log(`   ${row.waveId ? `wave: ${row.waveId}` : ''}${row.orderingSessionId ? `  session: ${row.orderingSessionId}` : ''}`);
  console.log(`   група: ${row.groupName}  відкрита: ${fmtDT(row.openedAt)}  статус: ${row.status || 'legacy'}`);
  console.log(`   товарів: ${row.itemCount}  заявок: ${row.requestCount}`);
  for (const seller of row.sellers) {
    console.log(`\n   👤 ${seller.name}  tg ${seller.telegramId || '—'}  магазин: ${seller.shops.join(', ')}`);
    console.log(`      штук: ${seller.totalQty}  спаковано: ${seller.packedQty}`);
    for (const item of seller.items) {
      console.log(`      • ${item.product}: ${item.quantity} шт · ${item.status}${item.packed ? ' · packed' : ''}`);
    }
  }
}

function toCsv(rows) {
  const esc = (v) => {
    const s = str(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [['waveId', 'orderingSessionId', 'група', 'статус', 'telegramId', 'продавець', 'магазин', 'товар', 'кількість', 'packed']];
  for (const row of rows) {
    for (const seller of row.sellers) {
      for (const item of seller.items) {
        out.push([row.waveId, row.orderingSessionId, row.groupName, row.status || 'legacy', seller.telegramId, seller.name,
          item.shopName, item.product, item.quantity, item.packed ? 'так' : 'ні']);
      }
    }
  }
  return '\ufeff' + out.map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  if (!OPT.json) console.log('\n🔍 READ-ONLY: історія дозамовлення');

  if (OPT.list) {
    const modern = await listModernWaves(OPT.list);
    console.log(`\n📜 СУЧАСНІ ХВИЛІ (${modern.length}):`);
    for (const wave of modern) {
      console.log(`   ${fmtDT(wave.openedAt || wave.createdAt)}  ${str(wave._id)}  session ${str(wave.orderingSessionId)}  ${wave.status}`);
    }
    if (modern.length < OPT.list) {
      const legacy = await listLegacyWaves(OPT.list - modern.length);
      if (legacy.length) {
        console.log(`\n📜 LEGACY (${legacy.length}):`);
        for (const row of legacy) console.log(`   ${fmtDT(row.openedAt || row.createdAt)}  receipt ${str(row._id)}  items ${row.itemCount}`);
      }
    }
    await mongoose.disconnect();
    return;
  }

  let modern = await listModernWaves(OPT.active ? 0 : 1);
  const rows = [];
  for (const wave of modern) {
    const collected = await collect({ wave });
    if (collected) rows.push(collected);
  }

  // Historical compatibility: if no modern Wave matches a receipt/group request,
  // expose the old receipt-grouped rows instead of pretending history disappeared.
  if (!rows.length && !OPT.wave) {
    const legacy = await listLegacyWaves(OPT.active ? 0 : 1);
    for (const row of legacy) {
      const collected = await collect({ legacyReceiptId: row._id });
      if (collected) rows.push(collected);
    }
  }

  if (OPT.json) console.log(JSON.stringify(rows, null, 2));
  else if (!rows.length) console.log('\n   Хвиль дозамовлення не знайдено.');
  else rows.forEach(printWave);

  if (OPT.csv) {
    fs.writeFileSync(OPT.csv, toCsv(rows), 'utf8');
    if (!OPT.json) console.log(`\n💾 CSV: ${OPT.csv}`);
  }
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('FAILED:', error);
  process.exit(1);
});
