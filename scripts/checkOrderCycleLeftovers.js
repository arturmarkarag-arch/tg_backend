'use strict';

/**
 * checkOrderCycleLeftovers — READ-ONLY перевірка: що реально лишилось у базі
 * після scripts/wipeOrderCycle.js. Нічого не пише, нічого не змінює.
 *
 *   node scripts/checkOrderCycleLeftovers.js
 *
 * Головне, на що дивитись: рядок «база / host» угорі. Він має збігатися з тим,
 * до чого підключений ЖИВИЙ сервер (Render), а не тільки з локальним .env.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');

const pad = (n) => String(n).padStart(7);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  console.log(`\n🔍 READ-ONLY перевірка залишків`);
  console.log(`   база: ${db.databaseName}   host: ${mongoose.connection.host}\n`);

  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const count = async (n, q = {}) => (existing.has(n) ? db.collection(n).countDocuments(q) : 0);

  console.log('📦 КОЛЕКЦІЇ ЦИКЛУ ЗАМОВЛЕНЬ (має бути 0):');
  for (const n of ['orders', 'pickingtasks', 'orderingsessions', 'catalogreviews',
                   'supplementoffers', 'supplementrequests', 'clearedcarts']) {
    console.log(`   ${pad(await count(n))}  ${n}`);
  }

  // orderingsessions — ЄДИНА колекція зі списку, яка законно відроджується сама:
  // getOrCreateSessionId() у telegram.js:108 створює сесію групи при кожному вході
  // в мініапку. Порожня сесія (seq: null, pickingStatus: 'pending', без замовлень)
  // — це не залишок тестів. Реальний залишок — сесія з seq або зі статусом.
  if (existing.has('orderingsessions')) {
    const sessions = await db.collection('orderingsessions').find({}).sort({ createdAt: 1 }).toArray();
    if (sessions.length) {
      const groups = existing.has('deliverygroups')
        ? await db.collection('deliverygroups').find({}, { projection: { name: 1 } }).toArray()
        : [];
      const groupName = new Map(groups.map((g) => [String(g._id), g.name]));
      console.log(`\n   Сесії детально (груп доставки: ${groups.length}):`);
      for (const s of sessions) {
        const orders = await count('orders', { orderingSessionId: String(s._id) });
        const flag = (s.seq != null || s.pickingStatus !== 'pending' || orders > 0)
          ? '  ← НЕ порожня'
          : '';
        console.log(`     ${s.openDate}  ${groupName.get(String(s.groupId)) || s.groupId}`);
        console.log(`        seq=${s.seq ?? 'null'} pickingStatus=${s.pickingStatus} замовлень=${orders} створена=${s.createdAt ? new Date(s.createdAt).toISOString() : '—'}${flag}`);
      }
      console.log('\n   Порожня сесія (seq=null, pending, 0 замовлень) — це нормально:');
      console.log('   сервер створює її сам при вході в мініапку, видаляти нема сенсу.');
    }
  }

  console.log('\n👤 СТАН КОРИСТУВАЧІВ (має бути 0, окрім «усього»):');
  console.log(`   ${pad(await count('users'))}  усього акаунтів`);
  console.log(`   ${pad(await count('users', { 'cartState.lastViewedProductId': { $nin: ['', null] } }))}  з непорожнім cartState.lastViewedProductId`);
  console.log(`   ${pad(await count('users', { 'cartState.currentIndex': { $gt: 0 } }))}  з cartState.currentIndex > 0`);
  console.log(`   ${pad(await count('users', { 'cartState.currentPage': { $gt: 0 } }))}  з cartState.currentPage > 0`);
  console.log(`   ${pad(await count('users', { 'cartState.navigationSessionId': { $nin: ['', null] } }))}  з непорожнім cartState.navigationSessionId`);
  console.log(`   ${pad(await count('users', { 'cartState.orderItemIds.0': { $exists: true } }))}  з непорожнім кошиком`);
  console.log(`   ${pad(await count('users', { 'history.0': { $exists: true } }))}  з непорожньою history`);

  // Хто саме тримає стан — щоб було видно, чи це один акаунт, який просто
  // сидить у відкритій мініапці й записує позицію назад.
  if (existing.has('users')) {
    const dirty = await db.collection('users').find(
      { $or: [
        { 'cartState.lastViewedProductId': { $nin: ['', null] } },
        { 'cartState.currentIndex': { $gt: 0 } },
        { 'cartState.currentPage': { $gt: 0 } },
      ] },
      { projection: { telegramId: 1, firstName: 1, lastName: 1, role: 1, cartState: 1 } },
    ).limit(10).toArray();
    if (dirty.length) {
      console.log('\n   Хто саме (до 10):');
      for (const u of dirty) {
        const cs = u.cartState || {};
        console.log(`     ${u.telegramId} ${u.firstName || ''} ${u.lastName || ''} [${u.role}]`);
        console.log(`        productId=${cs.lastViewedProductId || '—'} index=${cs.currentIndex} page=${cs.currentPage}`);
        console.log(`        updatedAt=${cs.updatedAt ? new Date(cs.updatedAt).toISOString() : 'null'}  navSession=${cs.navigationSessionId || '—'}`);
      }
      console.log('\n   Якщо updatedAt ПІЗНІШЕ за час запуску чистки — стан записав назад');
      console.log('   клієнт (відкрита мініапка), а не скрипт «не спрацював».');
    }
  }

  console.log('\n🔢 ЛІЧИЛЬНИКИ:');
  const counters = existing.has('counters')
    ? await db.collection('counters').find({}, { projection: { name: 1, seq: 1 } }).toArray()
    : [];
  if (!counters.length) console.log('        —   порожньо');
  for (const c of counters) console.log(`   ${pad(c.seq)}  ${c.name}`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
