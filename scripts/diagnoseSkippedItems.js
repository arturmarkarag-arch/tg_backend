'use strict';

/**
 * diagnoseSkippedItems — READ-ONLY розбір позицій із прапорцем `skipped`.
 * Нічого не пише і не змінює: лише find / countDocuments через НАТИВНИЙ драйвер.
 *
 * Моделі (../models/*) свідомо НЕ імпортуються: mongoose з autoIndex:true створює
 * індекси при першому використанні моделі, а це вже запис у живу базу.
 *
 *   node scripts/diagnoseSkippedItems.js                 # 10 останніх замовлень зі skipped за 14 днів
 *   node scripts/diagnoseSkippedItems.js --order=142     # конкретне замовлення за orderNumber
 *   node scripts/diagnoseSkippedItems.js --id=<ObjectId> # конкретне замовлення за _id
 *   node scripts/diagnoseSkippedItems.js --days=30 --limit=25
 *   node scripts/diagnoseSkippedItems.js --all-items     # друкувати всі позиції, не лише skipped
 *
 * На що дивитись: блок «ВЕРДИКТ» під кожною skipped-позицією — він каже, ЧОМУ
 * lateOrderReconcile не знайшов pending-задачі (services/lateOrderReconcile.js:93).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');

// ── аргументи ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const OPT = {
  orderNumber: arg('order') ? Number(arg('order')) : null,
  orderId: arg('id'),
  days: Number(arg('days', '14')),
  limit: Number(arg('limit', '10')),
  allItems: flag('all-items'),
};

// ── форматування ─────────────────────────────────────────────────────────────
const WARSAW = 'Europe/Warsaw';
const dtf = new Intl.DateTimeFormat('uk-UA', {
  timeZone: WARSAW, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const T = (d) => (d ? dtf.format(new Date(d)) : '—');
const money = (n) => Number(n || 0).toFixed(2);

/** Різниця у людському вигляді: скільки часу A настало ПІСЛЯ B. */
function delta(a, b) {
  if (!a || !b) return '';
  const ms = new Date(a).getTime() - new Date(b).getTime();
  const sign = ms >= 0 ? '+' : '−';
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  return `${sign}${h}год ${m}хв`;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI не заданий у .env');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const orders   = db.collection('orders');
  const tasks    = db.collection('pickingtasks');
  const sessions = db.collection('orderingsessions');
  const products = db.collection('products');
  const groups   = db.collection('deliverygroups');
  const blocks   = db.collection('blocks');

  console.log('\n🔍 READ-ONLY діагностика «Пропущено» (item.skipped)');
  console.log(`   база: ${db.databaseName}   host: ${mongoose.connection.host}\n`);

  // ── 0. Індивідуальні розклади груп ──────────────────────────────────────────
  // З v24 сервер не читає глобальний ordering.schedule. Розклад є частиною
  // DeliveryGroup, тому діагностика виводить конфігурацію всіх груп окремо.
  const groupSchedules = await groups
    .find({}, { projection: { name: 1, dayOfWeek: 1, orderingSchedule: 1 } })
    .sort({ name: 1 })
    .toArray();
  const dayLabels = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const fmtHm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  console.log('⏰ Індивідуальні вікна замовлень по групах:');
  for (const g of groupSchedules) {
    const v = g.orderingSchedule;
    if (!v) {
      console.log(`   ⚠️  ${g.name || g._id}: orderingSchedule ВІДСУТНІЙ`);
      continue;
    }
    console.log(`   • ${g.name || g._id}: ${dayLabels[v.startDay] ?? v.startDay} ${fmtHm(v.startHour, v.startMinute)}`
      + ` → ${dayLabels[v.endDay] ?? v.endDay} ${fmtHm(v.endHour, v.endMinute)}`
      + `; фізична доставка: ${dayLabels[g.dayOfWeek] ?? g.dayOfWeek}`);
  }
  console.log('');

  // ── 1. Вибірка замовлень ────────────────────────────────────────────────────
  const query = { 'items.skipped': true };
  if (OPT.orderId) {
    query._id = new mongoose.Types.ObjectId(OPT.orderId);
    delete query['items.skipped'];
  } else if (OPT.orderNumber != null && Number.isFinite(OPT.orderNumber)) {
    query.orderNumber = OPT.orderNumber;
    delete query['items.skipped'];
  } else {
    const since = new Date(Date.now() - OPT.days * 86_400_000);
    query.createdAt = { $gte: since };
  }

  const found = await orders.find(query).sort({ createdAt: -1 }).limit(OPT.limit).toArray();

  if (!found.length) {
    console.log('✅ Замовлень під критерій не знайдено.');
    if (!OPT.orderId && OPT.orderNumber == null) {
      const total = await orders.countDocuments({ 'items.skipped': true });
      console.log(`   (усього в базі замовлень зі skipped-позиціями: ${total} — спробуйте --days=90)`);
    }
    return;
  }

  const totalSkipped = await orders.countDocuments({ 'items.skipped': true });
  console.log(`📦 Знайдено ${found.length} замовлення(нь). Усього в базі зі skipped: ${totalSkipped}\n`);

  const groupCache = new Map();
  const getGroup = async (gid) => {
    if (!gid) return null;
    if (!groupCache.has(gid)) {
      let doc = null;
      try { doc = await groups.findOne({ _id: new mongoose.Types.ObjectId(gid) }); } catch { /* не ObjectId */ }
      groupCache.set(gid, doc);
    }
    return groupCache.get(gid);
  };

  for (const order of found) {
    const gid = order.buyerSnapshot?.deliveryGroupId || '';
    const group = await getGroup(gid);

    let session = null;
    if (order.orderingSessionId) {
      try { session = await sessions.findOne({ _id: new mongoose.Types.ObjectId(order.orderingSessionId) }); } catch { /* стрічка старого формату */ }
    }

    console.log('═'.repeat(96));
    console.log(`ЗАМОВЛЕННЯ #${order.orderNumber ?? '—'}   _id=${order._id}   статус: ${order.status}`);
    console.log(`  магазин: ${order.buyerSnapshot?.shopName || '—'} (${order.buyerSnapshot?.shopCity || '—'})   продавець tg: ${order.buyerTelegramId}`);
    console.log(`  група: ${group?.name || gid || '—'}   dayOfWeek=${group?.dayOfWeek ?? '—'}`);
    console.log(`  створено: ${T(order.createdAt)}   оновлено: ${T(order.updatedAt)}   сума: ${money(order.totalPrice)} zł`);

    if (session) {
      console.log(`\n  СЕСІЯ  openDate=${session.openDate}  seq=${session.seq ?? 'null'}  pickingStatus=${session.pickingStatus}`);
      console.log(`    підтверджено (старт збору): ${T(session.pickingConfirmedAt)}`);
      console.log(`    перша задача закрита:       ${T(session.pickingStartedAt)}`);
      console.log(`    збір завершено:             ${T(session.pickingCompletedAt)}`);
      const ev = (session.events || []).slice(-12);
      if (ev.length) {
        console.log('    події сесії (останні 12):');
        for (const e of ev) console.log(`      ${T(e.at)}  ${e.type}${e.byName ? `  — ${e.byName}` : ''}${e.meta && Object.keys(e.meta).length ? `  ${JSON.stringify(e.meta)}` : ''}`);
      }
    } else {
      console.log(`\n  ⚠️  СЕСІЯ не знайдена (orderingSessionId="${order.orderingSessionId || ''}")`);
    }

    // ── історія замовлення ────────────────────────────────────────────────────
    const hist = order.history || [];
    if (hist.length) {
      console.log('\n  ІСТОРІЯ ЗАМОВЛЕННЯ:');
      for (const h of hist) {
        const mark = ['late_items_skipped', 'late_skipped_all'].includes(h.action) ? ' ⬅ СКІП' : '';
        const rel = session?.pickingConfirmedAt ? `  [${delta(h.at, session.pickingConfirmedAt)} від старту збору]` : '';
        console.log(`    ${T(h.at)}  ${h.action}  by=${h.byName || h.by}(${h.byRole})  ${JSON.stringify(h.meta || {})}${rel}${mark}`);
      }
    }

    // ── позиції ───────────────────────────────────────────────────────────────
    const items = (order.items || []).filter((i) => (OPT.allItems ? true : i.skipped));
    console.log(`\n  ПОЗИЦІЇ (${OPT.allItems ? 'усі' : 'лише skipped'}): ${items.length} з ${(order.items || []).length}`);

    for (const item of items) {
      const pid = item.productId;
      const state = item.skipped ? 'SKIPPED' : item.cancelled ? 'cancelled' : item.packed ? 'packed' : 'активна';
      console.log('  ' + '─'.repeat(92));
      console.log(`  ▸ ${item.name || '—'}   ${money(item.price)} zł × ${item.quantity} шт.   [${state}]`);
      console.log(`    productId=${pid}`);

      // товар
      const product = pid ? await products.findOne({ _id: pid }, {
        projection: { brand: 1, model: 1, category: 1, warehouse: 1, price: 1, status: 1, orderNumber: 1, source: 1, createdAt: 1 },
      }) : null;
      if (!product) {
        console.log('    ТОВАР: ❌ документа немає (видалений) → задачі бути не могло');
      } else {
        const label = product.brand || product.model || product.category || product.warehouse || `#${product.orderNumber}`;
        const inBlock = await blocks.findOne({ productIds: product._id }, { projection: { blockId: 1 } });
        console.log(`    ТОВАР: "${label}"  status=${product.status}  price=${money(product.price)}  orderNumber=${product.orderNumber ?? '—'}`
          + `  source=${product.source || '—'}  створено=${T(product.createdAt)}`);
        console.log(`      у блоці: ${inBlock ? `так (блок ${inBlock.blockId})` : '❌ НЕ в жодному блоці'}`
          + `${!product.brand && !product.model && !product.category ? '   ⚠️ картка не заповнена (назва = фолбек "#N")' : ''}`
          + `${!product.price ? '   ⚠️ ціна 0' : ''}`);
      }

      // задачі по цьому товару в цій групі — увесь життєвий цикл, будь-який статус
      const related = pid ? await tasks.find({ productId: pid, deliveryGroupId: String(gid) }).sort({ createdAt: 1 }).toArray() : [];

      if (!related.length) {
        console.log('    ЗАДАЧІ: жодної задачі на цей товар у цій групі НЕ ІСНУЄ (і не існувало)');
      } else {
        console.log(`    ЗАДАЧІ на (товар × група): ${related.length}`);
        for (const t of related) {
          const mine = (t.items || []).find((x) => String(x.orderId) === String(order._id));
          const sameSession = String(t.orderingSessionId || '') === String(order.orderingSessionId || '');
          console.log(`      _id=${t._id}  status=${t.status}  reason=${t.completionReason || '—'}  блок ${t.blockId}/${t.positionIndex}`);
          console.log(`        сесія задачі: ${t.orderingSessionId || 'null'} ${sameSession ? '(та сама)' : '⚠️ ІНША СЕСІЯ'}`);
          console.log(`        створена ${T(t.createdAt)}   оновлена ${T(t.updatedAt)}   lockedBy=${t.lockedBy || '—'} lockedAt=${T(t.lockedAt)}`);
          console.log(`        закрив: ${t.completedByName || t.completedBy || '—'}   магазинів у задачі: ${(t.items || []).length}`);
          console.log(`        це замовлення в задачі: ${mine ? `ТАК (qty=${mine.quantity}, packed=${mine.packed})` : 'ні'}`);
        }
      }

      // ── вердикт ───────────────────────────────────────────────────────────────
      if (item.skipped) {
        const active = related.filter((t) => ['pending', 'locked'].includes(t.status));
        const pending = related.filter((t) => t.status === 'pending');
        const locked = related.filter((t) => t.status === 'locked');
        const completed = related.filter((t) => t.status === 'completed');

        let verdict;
        if (!product) {
          verdict = 'товар видалено з бази — задачу створити було ніяк';
        } else if (!related.length) {
          verdict = 'задачі не існувало НІКОЛИ → позиція не була в плані збору на момент старту '
            + '(додана після старту, або товар на той час був поза блоком / архівний)';
        } else if (locked.length && !pending.length) {
          verdict = `задача була ЗАЙНЯТА збирачем (locked${locked[0].lockedBy ? ` by ${locked[0].lockedBy}` : ''}) — `
            + 'товар фізично ще НЕ зібраний, але strict-фільтр status:\'pending\' її не приймає';
        } else if (completed.length && !active.length) {
          verdict = `задачу вже закрито о ${T(completed[completed.length - 1].updatedAt)}`
            + ` (причина: ${completed[completed.length - 1].completionReason || '—'}) — склад цей товар уже пройшов`;
        } else if (pending.length) {
          verdict = '⚠️ АНОМАЛІЯ: зараз існує PENDING-задача, а позиція все одно skipped → '
            + 'задачу створили ПІСЛЯ скіпу, або скіп стався в момент, коли вона була locked/completed';
        } else {
          verdict = 'причина не класифікована — дивіться таймлайн задач вище';
        }
        console.log(`    ВЕРДИКТ: ${verdict}`);

        if (session?.pickingConfirmedAt) {
          console.log(`      старт збору: ${T(session.pickingConfirmedAt)}   замовлення створено: ${T(order.createdAt)}`
            + `  [${delta(order.createdAt, session.pickingConfirmedAt)}]`);
        }
      }
    }
    console.log('');
  }

  console.log('═'.repeat(96));
  console.log('Готово. Жодного запису в базу не зроблено.\n');
}

main()
  .catch((err) => { console.error('\n❌', err.message, '\n', err.stack); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect().catch(() => {}); });
