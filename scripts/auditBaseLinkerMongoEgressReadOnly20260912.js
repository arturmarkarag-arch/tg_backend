'use strict';

// READ-ONLY estimator for the historical BaseLinkerOrderIndex write amplification.
// It never updates MongoDB and never calls BaseLinker. It measures the CURRENT
// durable queue rows and estimates how many bytes the pre-fix 30-second full
// rewrite would serialize per poll/day.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

for (const envPath of [path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../.env')]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

const BaseLinkerOrderIndex = require('../models/BaseLinkerOrderIndex');

const POLL_MS = Math.min(5 * 60_000, Math.max(15_000, Number(process.env.BASELINKER_QUEUE_REFRESH_MS) || 30_000));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const decimalGb = (value) => Number(value || 0) / 1_000_000_000;

function oldUpdateShape(row) {
  return {
    updateOne: {
      filter: { baseLinkerAccountId: row.baseLinkerAccountId, orderId: row.orderId },
      update: { $set: {
        baseLinkerAccountId: row.baseLinkerAccountId,
        orderId: row.orderId,
        orderIdNumeric: Number(row.orderIdNumeric || row.orderId || 0),
        orderSortDate: Number(row.orderSortDate || 0),
        sourceType: row.sourceType || '',
        sourceId: row.sourceId || '',
        preview: row.preview || null,
        searchText: row.searchText || '',
        syncToken: '00000000-0000-4000-8000-000000000000',
        seenAt: '2026-09-12T00:00:00.000Z',
      } },
      upsert: true,
    },
  };
}

function heartbeatShape(accountId, ids) {
  return {
    updateMany: {
      filter: { baseLinkerAccountId: accountId, orderId: { $in: ids } },
      update: { $set: { seenAt: '2026-09-12T00:00:00.000Z' } },
    },
  };
}

async function main() {
  if (!String(process.env.MONGODB_URI || '').trim()) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI, {
    autoCreate: false,
    autoIndex: false,
    readPreference: 'secondaryPreferred',
    serverSelectionTimeoutMS: 20_000,
    socketTimeoutMS: 60_000,
  });

  const rows = await BaseLinkerOrderIndex.find({})
    .select('baseLinkerAccountId orderId orderIdNumeric orderSortDate sourceType sourceId preview searchText')
    .lean();
  const byAccount = new Map();
  for (const row of rows) {
    const id = String(row.baseLinkerAccountId || '').trim() || '(missing)';
    if (!byAccount.has(id)) byAccount.set(id, []);
    byAccount.get(id).push(row);
  }

  const pollsPerDay = 86_400_000 / POLL_MS;
  const accounts = [];
  let oldBytesPerPoll = 0;
  let heartbeatBytesPerPoll = 0;
  for (const [accountId, accountRows] of byAccount) {
    const oldBytes = bytes(accountRows.map(oldUpdateShape));
    const heartbeatBytes = bytes(heartbeatShape(accountId, accountRows.map((row) => String(row.orderId || ''))));
    oldBytesPerPoll += oldBytes;
    heartbeatBytesPerPoll += heartbeatBytes;
    accounts.push({
      accountId,
      rows: accountRows.length,
      previewBytes: accountRows.reduce((sum, row) => sum + bytes(row.preview || null), 0),
      searchTextBytes: accountRows.reduce((sum, row) => sum + Buffer.byteLength(String(row.searchText || ''), 'utf8'), 0),
      estimatedOldSerializedBytesPerPoll: oldBytes,
      estimatedHeartbeatSerializedBytesPerPoll: heartbeatBytes,
      estimatedOldGbPerDay: Number(decimalGb(oldBytes * pollsPerDay).toFixed(4)),
      estimatedHeartbeatGbPerDay: Number(decimalGb(heartbeatBytes * pollsPerDay).toFixed(4)),
    });
  }

  const output = {
    readOnly: true,
    measuredAt: new Date().toISOString(),
    pollMs: POLL_MS,
    pollsPerDay,
    totalRows: rows.length,
    estimatedOldSerializedBytesPerPoll: oldBytesPerPoll,
    estimatedHeartbeatSerializedBytesPerPoll: heartbeatBytesPerPoll,
    estimatedOldGbPerDay: Number(decimalGb(oldBytesPerPoll * pollsPerDay).toFixed(4)),
    estimatedOldGbPer12Days: Number(decimalGb(oldBytesPerPoll * pollsPerDay * 12).toFixed(4)),
    estimatedHeartbeatGbPerDay: Number(decimalGb(heartbeatBytesPerPoll * pollsPerDay).toFixed(4)),
    reductionPercentBeforeMongoWireOverhead: oldBytesPerPoll
      ? Number(((1 - heartbeatBytesPerPoll / oldBytesPerPoll) * 100).toFixed(2))
      : 0,
    note: 'Estimates serialized command content only. Actual Render bandwidth also includes Mongo wire/TLS/protocol overhead and other service-initiated traffic.',
    accounts,
  };
  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error('BASELINKER MONGO EGRESS AUDIT FAILED');
    console.error(error?.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch (_) { /* noop */ }
  });
