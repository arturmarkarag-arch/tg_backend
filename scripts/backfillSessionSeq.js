'use strict';

/**
 * backfillSessionSeq — assigns the missing human-facing OrderingSession.seq
 * values to sessions that actually contain at least one Order, independently
 * per DeliveryGroup, in chronological order.
 *
 * Empty sessions intentionally stay seq=null and consume no number.
 * Existing seq values are never rewritten. If they contradict chronological
 * numbering the script stops and asks for manual review rather than guessing.
 *
 * DRY-RUN by default:
 *   node scripts/backfillSessionSeq.js
 *   node scripts/backfillSessionSeq.js --execute
 *
 * No project models are imported: no autoIndex side effects.
 */

const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const EXECUTE = process.argv.includes('--execute');
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

function sortSessions(a, b) {
  const da = String(a.openDate || '');
  const db = String(b.openDate || '');
  if (da !== db) return da.localeCompare(db);
  const ta = new Date(a.openAt || a.createdAt || 0).getTime() || 0;
  const tb = new Date(b.openAt || b.createdAt || 0).getTime() || 0;
  if (ta !== tb) return ta - tb;
  return String(a._id).localeCompare(String(b._id));
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI не заданий у .env');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20_000 });
  const db = mongoose.connection.db;
  const sessions = db.collection('orderingsessions');
  const orders = db.collection('orders');
  const counters = db.collection('counters');

  console.log(`\n🔢 backfillSessionSeq — режим: ${EXECUTE ? '⚠️  ЗАПИС (--execute)' : 'DRY-RUN (нічого не пишу)'}`);
  console.log(`   база: ${db.databaseName}   host: ${mongoose.connection.host}\n`);

  // Any status counts: an expired/cancelled historical order still proves that
  // the session had real content and therefore deserves its historical number.
  const orderSessionIds = await orders.distinct('orderingSessionId', {
    orderingSessionId: { $type: 'string', $ne: '' },
  });
  const validIds = orderSessionIds.filter((id) => OBJECT_ID_RE.test(String(id)));
  const legacyIds = orderSessionIds.filter((id) => !OBJECT_ID_RE.test(String(id)));
  if (legacyIds.length) {
    console.log(`⚠️  Пропущено legacy/non-ObjectId orderingSessionId: ${legacyIds.length}`);
  }

  if (!validIds.length) {
    console.log('✅ Жодної materialized session з Orders не знайдено. Робити нічого.\n');
    return;
  }

  const ObjectId = mongoose.Types.ObjectId;
  const rows = await sessions.find({
    _id: { $in: validIds.map((id) => new ObjectId(id)) },
  }).project({ groupId: 1, openDate: 1, openAt: 1, createdAt: 1, seq: 1 }).toArray();

  const missingSessionDocs = validIds.length - rows.length;
  if (missingSessionDocs > 0) {
    throw new Error(`${missingSessionDocs} orderingSessionId з Orders не мають OrderingSession документа`);
  }

  const byGroup = new Map();
  for (const row of rows) {
    const gid = String(row.groupId || '');
    if (!gid) throw new Error(`Session ${row._id} не має groupId`);
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(row);
  }

  const plans = [];
  let anomalyCount = 0;
  for (const [groupId, groupSessions] of [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    groupSessions.sort(sortSessions);
    const counterName = `session-seq:${groupId}`;
    const counter = await counters.findOne({ name: counterName }, { projection: { seq: 1 } });
    const currentCounter = Number(counter?.seq || 0);

    console.log(`ГРУПА ${groupId} · сесій з Orders: ${groupSessions.length} · counter=${currentCounter || 'немає'}`);

    for (let i = 0; i < groupSessions.length; i += 1) {
      const row = groupSessions[i];
      const expected = i + 1;
      const current = row.seq == null ? null : Number(row.seq);
      const state = current == null
        ? `ПРИЗНАЧИТИ №${expected}`
        : current === expected
          ? `OK №${current}`
          : `❌ Є №${current}, очікувано №${expected}`;
      console.log(`  ${row.openDate || '—'}  ${row._id}  ${state}`);
      if (current != null && current !== expected) anomalyCount += 1;
      if (current == null) plans.push({ _id: row._id, groupId, seq: expected });
    }

    if (currentCounter > groupSessions.length) {
      console.log(`  ❌ counter=${currentCounter} > кількості нумерованих сесій ${groupSessions.length}; це вже дірка в послідовності`);
      anomalyCount += 1;
    }
    console.log('');
  }

  if (anomalyCount) {
    throw new Error(`Знайдено ${anomalyCount} суперечностей seq/counter. Автовиправлення зупинено.`);
  }

  console.log(`РАЗОМ призначити: ${plans.length} session.seq`);
  if (!EXECUTE) {
    console.log('DRY-RUN — у базу нічого не записано.');
    console.log('Для застосування: node scripts/backfillSessionSeq.js --execute\n');
    return;
  }

  // Filter seq:null makes reruns/concurrent runtime assignment non-destructive.
  if (plans.length) {
    await sessions.bulkWrite(plans.map((plan) => ({
      updateOne: {
        filter: { _id: plan._id, seq: null },
        update: { $set: { seq: plan.seq } },
      },
    })), { ordered: true });
  }

  // Counter can only move forward. Never lower a counter that may have advanced
  // concurrently; verification below catches any resulting mismatch.
  for (const [groupId, groupSessions] of byGroup.entries()) {
    const target = groupSessions.length;
    await counters.updateOne(
      { name: `session-seq:${groupId}` },
      {
        $max: { seq: target },
        $setOnInsert: { name: `session-seq:${groupId}`, createdAt: new Date() },
        $set: { updatedAt: new Date() },
      },
      { upsert: true },
    );
  }

  // Strong verification: every content-bearing session must now have exactly its
  // chronological 1..N value. If a concurrent writer raced us, fail loudly.
  let verifyErrors = 0;
  for (const [groupId, groupSessions] of byGroup.entries()) {
    const fresh = await sessions.find({ _id: { $in: groupSessions.map((row) => row._id) } })
      .project({ groupId: 1, openDate: 1, openAt: 1, createdAt: 1, seq: 1 })
      .toArray();
    fresh.sort(sortSessions);
    for (let i = 0; i < fresh.length; i += 1) {
      if (Number(fresh[i].seq) !== i + 1) {
        verifyErrors += 1;
        console.error(`❌ VERIFY ${groupId} ${fresh[i]._id}: seq=${fresh[i].seq} expected=${i + 1}`);
      }
    }
    const counter = await counters.findOne({ name: `session-seq:${groupId}` });
    if (Number(counter?.seq || 0) < fresh.length) {
      verifyErrors += 1;
      console.error(`❌ VERIFY ${groupId}: counter=${counter?.seq ?? null} < ${fresh.length}`);
    }
  }

  if (verifyErrors) throw new Error(`VERIFY FAIL: ${verifyErrors} невідповідностей`);
  console.log('✅ VERIFY PASS — session.seq заповнено, counters засіяно.\n');
}

main()
  .catch((err) => {
    console.error('\n❌', err.message, '\n', err.stack);
    process.exitCode = 1;
  })
  .finally(async () => { await mongoose.disconnect().catch(() => {}); });
