'use strict';

/**
 * sellersLastSeen — READ-ONLY: коли кожного продавця востаннє «бачили».
 *
 * ВАЖЛИВО про точність. Окремого поля «останній запуск мініаппа» в базі НЕМАЄ,
 * тож дата збирається з наявних слідів (найсвіжіший виграє):
 *
 *   каталог   User.miniAppState.updatedAt  — записується, коли продавець гортав
 *                                            каталог / міняв режим перегляду
 *                                            (routes/v1/telegram.js). Найближче
 *                                            до «був у додатку», але тихий вхід
 *                                            без жодного руху не фіксується.
 *   кошик     User.cartState.updatedAt     — те саме + скидання на новій сесії.
 *   бот       User.botLastActivityAt       — взаємодія з БОТОМ, не з мініаппом
 *                                            (telegramBot.js).
 *   замовлення Order.createdAt             — факт замовлення (100% був у додатку).
 *   дозамовлення SupplementRequest.createdAt — те саме для дозамовлень.
 *
 * User.lastActive і User.isOnline НЕ використовуються: їх ніхто не оновлює,
 * lastActive = дата створення акаунта.
 *
 *   node scripts/sellersLastSeen.js                 # усі продавці, найдавніші зверху
 *   node scripts/sellersLastSeen.js --recent        # найсвіжіші зверху
 *   node scripts/sellersLastSeen.js --days=14       # тільки ті, кого не було 14+ днів
 *   node scripts/sellersLastSeen.js --group=Четвер
 *   node scripts/sellersLastSeen.js --role=all      # + склад і адміни
 *   node scripts/sellersLastSeen.js --html=lastseen.html   # звіт для браузера
 *   node scripts/sellersLastSeen.js --json
 *   node scripts/sellersLastSeen.js --csv=lastseen.csv
 *
 * Нічого не пише в базу.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const mongoose = require('mongoose');

const User  = require('../models/User');
const Shop  = require('../models/Shop');
const Order = require('../models/Order');
const DeliveryGroup = require('../models/DeliveryGroup');
const SupplementRequest = require('../models/SupplementRequest');

// ─── Аргументи ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const optOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const OPT = {
  recent: hasFlag('recent'),
  days:   Number.parseInt(optOf('days'), 10) || 0,
  group:  optOf('group'),
  role:   (optOf('role') || 'seller').toLowerCase(),
  json:   hasFlag('json'),
  csv:    optOf('csv'),
  html:   hasFlag('html') ? (optOf('html') || 'lastseen.html') : null,
};

// ─── Форматування ────────────────────────────────────────────────────────────

const fmtDate = (d) => (d
  ? new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric',
    }).format(new Date(d))
  : '—');

const fmtDT = (d) => (d
  ? new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(d))
  : '—');

const plural = (n, one, few, many) => {
  const m10 = Math.abs(n) % 10;
  const m100 = Math.abs(n) % 100;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
};

const daysAgo = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);
const agoLabel = (d) => {
  const n = daysAgo(d);
  if (n === null) return 'ніколи';
  if (n === 0) return 'сьогодні';
  if (n === 1) return 'вчора';
  return `${n} ${plural(n, 'день', 'дні', 'днів')} тому`;
};

const fullName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();
const maxDate = (...dates) => {
  const valid = dates.filter(Boolean).map((d) => new Date(d));
  return valid.length ? new Date(Math.max(...valid.map((d) => d.getTime()))) : null;
};

// ─── Збір ────────────────────────────────────────────────────────────────────

async function resolveGroup(raw) {
  const val = String(raw || '').trim();
  if (!val) return null;
  if (mongoose.Types.ObjectId.isValid(val)) {
    const byId = await DeliveryGroup.findById(val, 'name dayOfWeek').lean();
    if (byId) return byId;
  }
  const found = await DeliveryGroup.find(
    { name: new RegExp(`^${val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    'name dayOfWeek',
  ).lean();
  if (found.length === 1) return found[0];
  if (found.length > 1) throw new Error(`Назва групи «${val}» неоднозначна: знайдено ${found.length}`);
  throw new Error(`Групу доставки «${val}» не знайдено`);
}

async function collect() {
  const userFilter = {};
  if (OPT.role !== 'all') userFilter.role = OPT.role;

  let groupFilterName = '';
  if (OPT.group) {
    const group = await resolveGroup(OPT.group);
    groupFilterName = group.name;
    const shopIds = await Shop.find({ deliveryGroupId: String(group._id) }, '_id').lean();
    userFilter.shopId = { $in: shopIds.map((s) => s._id) };
  }

  const users = await User.find(
    userFilter,
    'telegramId role firstName lastName shopId botBlocked botLastActivityAt miniAppState cartState createdAt',
  ).lean();

  const shops = await Shop.find(
    { _id: { $in: users.map((u) => u.shopId).filter(Boolean) } },
    'name deliveryGroupId isActive',
  ).lean();
  const shopById = new Map(shops.map((s) => [String(s._id), s]));
  const groups = await DeliveryGroup.find({}, 'name').lean();
  const groupName = new Map(groups.map((g) => [String(g._id), g.name]));

  const tgIds = users.map((u) => String(u.telegramId));

  // Останнє замовлення та остання заявка дозамовлення — одним проходом кожне.
  const [lastOrders, lastSupplements] = await Promise.all([
    Order.aggregate([
      { $match: { buyerTelegramId: { $in: tgIds } } },
      { $group: { _id: '$buyerTelegramId', at: { $max: '$createdAt' }, count: { $sum: 1 } } },
    ]),
    SupplementRequest.aggregate([
      { $match: { createdBy: { $in: tgIds } } },
      { $group: { _id: '$createdBy', at: { $max: '$createdAt' }, count: { $sum: 1 } } },
    ]),
  ]);
  const orderBy = new Map(lastOrders.map((r) => [String(r._id), r]));
  const supBy = new Map(lastSupplements.map((r) => [String(r._id), r]));

  const rows = users.map((u) => {
    const shop = u.shopId ? shopById.get(String(u.shopId)) : null;
    const sources = {
      catalog:    u.miniAppState?.updatedAt || null,
      cart:       u.cartState?.updatedAt || null,
      bot:        u.botLastActivityAt || null,
      order:      orderBy.get(String(u.telegramId))?.at || null,
      supplement: supBy.get(String(u.telegramId))?.at || null,
    };
    const lastSeen = maxDate(...Object.values(sources));
    const sourceLabels = {
      catalog: 'каталог', cart: 'кошик', bot: 'бот',
      order: 'замовлення', supplement: 'дозамовлення',
    };
    const via = lastSeen
      ? Object.entries(sources)
          .filter(([, v]) => v && new Date(v).getTime() === lastSeen.getTime())
          .map(([k]) => sourceLabels[k])
          .join(' + ')
      : '';
    // «У додатку» = сліди самого мініаппа; бот сюди не входить.
    const lastInApp = maxDate(sources.catalog, sources.cart, sources.order, sources.supplement);

    return {
      telegramId: String(u.telegramId),
      name: fullName(u) || '(ім’я невідоме)',
      role: u.role,
      botBlocked: Boolean(u.botBlocked),
      registeredAt: u.createdAt || null,
      shopName: shop?.name || (u.shopId ? `(магазин ${String(u.shopId)} видалено)` : '— без магазину'),
      shopActive: shop ? shop.isActive !== false : null,
      groupName: shop?.deliveryGroupId ? (groupName.get(String(shop.deliveryGroupId)) || shop.deliveryGroupId) : '—',
      sources,
      lastSeen,
      lastInApp,
      via,
      orderCount: orderBy.get(String(u.telegramId))?.count || 0,
      supplementCount: supBy.get(String(u.telegramId))?.count || 0,
    };
  });

  const filtered = OPT.days
    ? rows.filter((r) => !r.lastSeen || daysAgo(r.lastSeen) >= OPT.days)
    : rows;

  // Без сліду взагалі — завжди вгорі у «найдавніших», унизу у «найсвіжіших».
  filtered.sort((a, b) => {
    const at = a.lastSeen ? a.lastSeen.getTime() : (OPT.recent ? -Infinity : -1);
    const bt = b.lastSeen ? b.lastSeen.getTime() : (OPT.recent ? -Infinity : -1);
    return OPT.recent ? bt - at : at - bt;
  });

  return { rows: filtered, total: rows.length, groupFilterName };
}

// ─── Вивід ───────────────────────────────────────────────────────────────────

function printRows({ rows, total, groupFilterName }) {
  const head = [
    `роль: ${OPT.role}`,
    groupFilterName ? `група: ${groupFilterName}` : null,
    OPT.days ? `не заходили ${OPT.days}+ ${plural(OPT.days, 'день', 'дні', 'днів')}` : null,
    OPT.recent ? 'найсвіжіші зверху' : 'найдавніші зверху',
  ].filter(Boolean).join('   ·   ');
  console.log(`\n👥 ОСТАННЯ АКТИВНІСТЬ — показано ${rows.length} з ${total}`);
  console.log(`   ${head}\n`);

  for (const r of rows) {
    const warn = [
      r.botBlocked ? 'бот заблокований' : null,
      r.shopActive === false ? 'магазин неактивний' : null,
    ].filter(Boolean);
    console.log(`   ${r.lastSeen ? fmtDT(r.lastSeen) : 'НІКОЛИ'.padEnd(16)}  ${agoLabel(r.lastSeen).padEnd(14)}`
      + `${r.name}   tg ${r.telegramId}${warn.length ? `   ⚠️ ${warn.join(', ')}` : ''}`);
    console.log(`      ${r.shopName}  ·  ${r.groupName}  ·  джерело: ${r.via || '—'}`);
    console.log(`      каталог ${fmtDate(r.sources.catalog)} · кошик ${fmtDate(r.sources.cart)}`
      + ` · бот ${fmtDate(r.sources.bot)} · замовлення ${fmtDate(r.sources.order)} (${r.orderCount})`
      + ` · дозамовлення ${fmtDate(r.sources.supplement)} (${r.supplementCount})`);
    if (!r.lastSeen) console.log(`      зареєстрований ${fmtDate(r.registeredAt)}, жодного сліду активності`);
  }

  // ── Зведення по днях ──────────────────────────────────────────────────────
  const byDay = new Map();
  for (const r of rows) {
    const key = r.lastSeen ? fmtDate(r.lastSeen) : 'ніколи';
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r.name);
  }
  const toSortKey = (k) => (k === 'ніколи' ? '' : k.split('.').reverse().join('-'));
  const days = [...byDay.entries()].sort((a, b) => toSortKey(b[0]).localeCompare(toSortKey(a[0])));

  console.log(`\n📅 ПО ДАТАХ — коли востаннє бачили (${days.length} ${plural(days.length, 'дата', 'дати', 'дат')}):`);
  for (const [day, names] of days) {
    console.log(`   ${day.padEnd(12)} ${String(names.length).padStart(3)}  ${'█'.repeat(Math.min(names.length, 40))}`);
    console.log(`      ${names.join(', ')}`);
  }
  console.log('');
}

function toCsv(rows) {
  const csvEsc = (v) => {
    const s = String(v ?? '');
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [[
    'telegramId', 'ім\'я', 'роль', 'магазин', 'група', 'востаннєбачили', 'днівтому',
    'джерело', 'каталог', 'кошик', 'бот', 'останнєзамовлення', 'замовлень',
    'останнєдозамовлення', 'дозамовлень', 'ботзаблокований',
  ]];
  for (const r of rows) {
    out.push([
      r.telegramId, r.name, r.role, r.shopName, r.groupName,
      r.lastSeen ? fmtDT(r.lastSeen) : '', daysAgo(r.lastSeen) ?? '',
      r.via, fmtDT(r.sources.catalog), fmtDT(r.sources.cart), fmtDT(r.sources.bot),
      fmtDT(r.sources.order), r.orderCount, fmtDT(r.sources.supplement), r.supplementCount,
      r.botBlocked ? 'так' : 'ні',
    ]);
  }
  return '﻿' + out.map((r) => r.map(csvEsc).join(';')).join('\r\n') + '\r\n';
}

// ─── HTML-звіт ───────────────────────────────────────────────────────────────

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Самодостатня сторінка: без CDN, без мережі — просто відкрити у браузері. */
function renderHtml({ rows, total, groupFilterName }, meta) {
  const bucketOf = (r) => {
    const n = daysAgo(r.lastSeen);
    if (n === null) return 'never';
    if (n <= 7) return 'fresh';
    if (n <= 30) return 'warm';
    return 'cold';
  };
  const bucketLabel = {
    fresh: 'до 7 днів', warm: '8–30 днів', cold: 'понад 30 днів', never: 'жодного сліду',
  };
  const counts = { fresh: 0, warm: 0, cold: 0, never: 0 };
  for (const r of rows) counts[bucketOf(r)] += 1;

  // Гістограма: скільки людей востаннє бачили саме того дня.
  const byDay = new Map();
  for (const r of rows) {
    const key = r.lastSeen ? fmtDate(r.lastSeen) : 'ніколи';
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  }
  const sortKey = (k) => (k === 'ніколи' ? '' : k.split('.').reverse().join('-'));
  const days = [...byDay.entries()].sort((a, b) => sortKey(b[0]).localeCompare(sortKey(a[0])));
  const maxDay = Math.max(1, ...days.map(([, list]) => list.length));

  const dayRows = days.map(([day, list]) => `
    <div class="day">
      <div class="day-label">${esc(day)}</div>
      <div class="day-bar"><span style="width:${(list.length / maxDay) * 100}%"></span></div>
      <div class="day-count">${list.length}</div>
      <div class="day-names">${esc(list.map((r) => r.name).join(', '))}</div>
    </div>`).join('');

  const tableRows = rows.map((r) => {
    const b = bucketOf(r);
    const n = daysAgo(r.lastSeen);
    const flags = [
      r.botBlocked ? '<span class="flag">бот заблокований</span>' : '',
      r.shopActive === false ? '<span class="flag">магазин неактивний</span>' : '',
    ].join('');
    return `
    <tr data-bucket="${b}" data-search="${esc([r.name, r.telegramId, r.shopName, r.groupName].join(' ').toLowerCase())}">
      <td data-sort="${r.lastSeen ? r.lastSeen.getTime() : 0}">
        <div class="when ${b}">${r.lastSeen ? esc(fmtDT(r.lastSeen)) : 'ніколи'}</div>
        <div class="ago">${esc(agoLabel(r.lastSeen))}</div>
      </td>
      <td data-sort="${esc(r.name.toLowerCase())}">
        <div class="name">${esc(r.name)}${flags}</div>
        <div class="sub">tg ${esc(r.telegramId)} · ${esc(r.role)}</div>
      </td>
      <td data-sort="${esc(r.shopName.toLowerCase())}">
        <div>${esc(r.shopName)}</div>
        <div class="sub">${esc(r.groupName)}</div>
      </td>
      <td data-sort="${esc(r.via)}"><span class="via">${esc(r.via || '—')}</span></td>
      <td class="src" data-sort="${r.sources.catalog ? new Date(r.sources.catalog).getTime() : 0}">${esc(fmtDate(r.sources.catalog))}</td>
      <td class="src" data-sort="${r.sources.cart ? new Date(r.sources.cart).getTime() : 0}">${esc(fmtDate(r.sources.cart))}</td>
      <td class="src" data-sort="${r.sources.bot ? new Date(r.sources.bot).getTime() : 0}">${esc(fmtDate(r.sources.bot))}</td>
      <td class="src" data-sort="${r.sources.order ? new Date(r.sources.order).getTime() : 0}">${esc(fmtDate(r.sources.order))}<span class="cnt">${r.orderCount || ''}</span></td>
      <td class="src" data-sort="${r.sources.supplement ? new Date(r.sources.supplement).getTime() : 0}">${esc(fmtDate(r.sources.supplement))}<span class="cnt">${r.supplementCount || ''}</span></td>
      <td class="num" data-sort="${n === null ? 999999 : n}">${n === null ? '—' : n}</td>
    </tr>`;
  }).join('');

  const filters = [
    `роль: ${OPT.role}`,
    groupFilterName ? `група: ${groupFilterName}` : null,
    OPT.days ? `лише ті, кого не було ${OPT.days}+ днів` : null,
  ].filter(Boolean).join(' · ');

  const chip = (key) => `<button class="chip" data-filter="${key}">${bucketLabel[key]}<b>${counts[key]}</b></button>`;

  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Остання активність продавців</title>
<style>
  :root {
    --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#6b7280; --line:#e5e7eb;
    --fresh:#12855b; --warm:#b45309; --cold:#b91c1c; --never:#6b7280; --accent:#2563eb;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --card:#171a21; --text:#e8eaed; --muted:#9aa3af; --line:#2a2f3a;
            --fresh:#34d399; --warm:#fbbf24; --cold:#f87171; --never:#9aa3af; --accent:#60a5fa; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:1240px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .meta { color:var(--muted); font-size:13px; margin-bottom:16px; }
  .note { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--warm);
          border-radius:10px; padding:12px 14px; margin-bottom:20px; font-size:14px; }
  .note b { color:var(--warm); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:22px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card .n { font-size:28px; font-weight:650; line-height:1.1; }
  .card .l { color:var(--muted); font-size:13px; margin-top:2px; }
  .card.fresh .n { color:var(--fresh); } .card.warm .n { color:var(--warm); }
  .card.cold .n { color:var(--cold); }  .card.never .n { color:var(--never); }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px;
            padding:16px; margin-bottom:20px; }
  section h2 { font-size:15px; margin:0 0 12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .day { display:grid; grid-template-columns:96px 1fr 40px; gap:10px; align-items:center; margin-bottom:6px; }
  .day-label { font-variant-numeric:tabular-nums; font-size:13px; color:var(--muted); }
  .day-bar { background:color-mix(in srgb, var(--accent) 15%, transparent); border-radius:5px; height:18px; }
  .day-bar span { display:block; height:100%; background:var(--accent); border-radius:5px; }
  .day-count { text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
  .day-names { grid-column:2 / -1; font-size:12px; color:var(--muted); margin:-2px 0 8px; }
  .tools { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
  input[type=search] { flex:1; min-width:200px; padding:9px 12px; border-radius:9px;
                       border:1px solid var(--line); background:var(--bg); color:var(--text); font-size:14px; }
  .chip { border:1px solid var(--line); background:var(--bg); color:var(--text); cursor:pointer;
          border-radius:999px; padding:7px 12px; font-size:13px; }
  .chip b { margin-left:6px; font-variant-numeric:tabular-nums; }
  .chip.on { border-color:var(--accent); color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.03em; color:var(--muted);
       cursor:pointer; user-select:none; white-space:nowrap; position:sticky; top:0; background:var(--card); }
  th:hover { color:var(--accent); }
  .when { font-weight:600; font-variant-numeric:tabular-nums; }
  .when.fresh { color:var(--fresh); } .when.warm { color:var(--warm); }
  .when.cold { color:var(--cold); }   .when.never { color:var(--never); }
  .ago, .sub { color:var(--muted); font-size:12px; }
  .name { font-weight:600; }
  .flag { display:inline-block; margin-left:6px; padding:1px 7px; border-radius:999px; font-size:11px;
          font-weight:500; color:var(--cold); border:1px solid var(--cold); }
  .via { font-size:12px; padding:2px 8px; border-radius:999px; background:var(--bg); border:1px solid var(--line); }
  .src { font-variant-numeric:tabular-nums; color:var(--muted); font-size:13px; white-space:nowrap; }
  .cnt { display:inline-block; margin-left:5px; font-size:11px; color:var(--accent); }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .scroll { overflow-x:auto; }
  .legend { font-size:13px; color:var(--muted); }
  .legend li { margin-bottom:4px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Коли продавців востаннє бачили в додатку</h1>
  <div class="meta">
    Звіт сформовано ${esc(meta.generatedAt)} · база <b>${esc(meta.db)}</b> · показано ${rows.length} з ${total}
    ${filters ? ' · ' + esc(filters) : ''}
  </div>

  <div class="note">
    <b>Як читати.</b> Окремого поля «останній запуск додатка» в базі немає. Дата зібрана зі слідів:
    гортання каталогу, кошик, взаємодія з ботом, замовлення, дозамовлення — береться найсвіжіший.
    Якщо продавець відкрив додаток і вийшов, нічого не торкнувшись, такий вхід <b>не зафіксується</b>,
    тож реальна активність може бути трохи свіжішою за показану. Колонка «джерело» показує,
    звідки саме взялась дата.
  </div>

  <div class="cards">
    <div class="card"><div class="n">${rows.length}</div><div class="l">усього в звіті</div></div>
    <div class="card fresh"><div class="n">${counts.fresh}</div><div class="l">були за останні 7 днів</div></div>
    <div class="card warm"><div class="n">${counts.warm}</div><div class="l">8–30 днів тому</div></div>
    <div class="card cold"><div class="n">${counts.cold}</div><div class="l">понад 30 днів тому</div></div>
    <div class="card never"><div class="n">${counts.never}</div><div class="l">жодного сліду</div></div>
  </div>

  <section>
    <h2>По датах — кого востаннє бачили того дня</h2>
    ${dayRows || '<div class="legend">Немає даних</div>'}
  </section>

  <section>
    <h2>Люди</h2>
    <div class="tools">
      <input type="search" id="q" placeholder="Пошук: ім'я, telegramId, магазин, група…">
      ${chip('fresh')}${chip('warm')}${chip('cold')}${chip('never')}
    </div>
    <div class="scroll">
      <table id="t">
        <thead><tr>
          <th data-type="num">Востаннє</th>
          <th>Продавець</th>
          <th>Магазин / група</th>
          <th>Джерело</th>
          <th data-type="num">Каталог</th>
          <th data-type="num">Кошик</th>
          <th data-type="num">Бот</th>
          <th data-type="num">Замовлення</th>
          <th data-type="num">Дозамовлення</th>
          <th data-type="num">Днів</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Що означає кожна колонка</h2>
    <ul class="legend">
      <li><b>Каталог</b> — продавець гортав товари або міняв режим перегляду в мініаппі.</li>
      <li><b>Кошик</b> — зміни кошика; також оновлюється при старті нової сесії замовлень.</li>
      <li><b>Бот</b> — писав боту або тиснув кнопку в чаті. Це не мініапп.</li>
      <li><b>Замовлення</b> / <b>Дозамовлення</b> — дата останнього; синім числом — скільки всього за весь час.</li>
    </ul>
  </section>
</div>
<script>
  var tbody = document.querySelector('#t tbody');
  var rows = Array.prototype.slice.call(tbody.rows);
  var active = null;

  function apply() {
    var q = document.getElementById('q').value.trim().toLowerCase();
    rows.forEach(function (tr) {
      var okQ = !q || tr.dataset.search.indexOf(q) !== -1;
      var okB = !active || tr.dataset.bucket === active;
      tr.style.display = (okQ && okB) ? '' : 'none';
    });
  }
  document.getElementById('q').addEventListener('input', apply);
  Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
    c.addEventListener('click', function () {
      var key = c.dataset.filter;
      active = (active === key) ? null : key;
      Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (x) {
        x.classList.toggle('on', x.dataset.filter === active);
      });
      apply();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('#t th'), function (th, i) {
    var asc = false;
    th.addEventListener('click', function () {
      asc = !asc;
      var num = th.dataset.type === 'num';
      rows.sort(function (a, b) {
        var x = a.cells[i].dataset.sort, y = b.cells[i].dataset.sort;
        var r = num ? (Number(x) - Number(y)) : String(x).localeCompare(String(y), 'uk');
        return asc ? r : -r;
      });
      rows.forEach(function (tr) { tbody.appendChild(tr); });
    });
  });
</script>
</body>
</html>`;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  if (!OPT.json) {
    console.log(`\n🔍 READ-ONLY: коли продавців востаннє бачили в додатку`);
    console.log(`   база: ${mongoose.connection.db.databaseName}   host: ${mongoose.connection.host}`);
    console.log(`   ⚠️  окремого поля «останній запуск» немає — дата зібрана зі слідів,`);
    console.log(`      тихий вхід без жодної дії у каталозі не фіксується.`);
  }

  const result = await collect();

  if (OPT.json) console.log(JSON.stringify(result.rows, null, 2));
  else printRows(result);

  if (OPT.csv) {
    fs.writeFileSync(OPT.csv, toCsv(result.rows), 'utf8');
    if (!OPT.json) console.log(`💾 CSV збережено: ${OPT.csv}\n`);
  }

  if (OPT.html) {
    fs.writeFileSync(OPT.html, renderHtml(result, {
      db: mongoose.connection.db.databaseName,
      generatedAt: fmtDT(new Date()),
    }), 'utf8');
    if (!OPT.json) console.log(`🌐 HTML-звіт збережено: ${require('path').resolve(OPT.html)}\n`);
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
