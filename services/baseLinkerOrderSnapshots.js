'use strict';

const crypto = require('crypto');
const BaseLinkerOrderSnapshot = require('../models/BaseLinkerOrderSnapshot');
const { getBaseLinkerAccountScope } = require('./baseLinkerAccount');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

function baseLinkerOrderSnapshotHash(order) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(order || {})), 'utf8')
    .digest('hex');
}

let snapshotIndexesReadyPromise = null;

async function ensureSnapshotIndexesReady() {
  if (!snapshotIndexesReadyPromise) {
    snapshotIndexesReadyPromise = BaseLinkerOrderSnapshot.syncIndexes().catch((error) => {
      snapshotIndexesReadyPromise = null;
      throw error;
    });
  }
  return snapshotIndexesReadyPromise;
}

async function recordBaseLinkerOrderSnapshots(orders = [], { source = 'unknown' } = {}) {
  const rows = (Array.isArray(orders) ? orders : []).filter((order) => Number(order?.order_id) > 0);
  if (!rows.length) return [];
  await ensureSnapshotIndexesReady();
  const accountScope = getBaseLinkerAccountScope();
  const observedAt = new Date();
  const records = rows.map((order) => ({
    accountScope,
    orderId: String(order.order_id),
    snapshotHash: baseLinkerOrderSnapshotHash(order),
    source: String(source || 'unknown').slice(0, 64),
    observedAt,
    order,
  }));
  try {
    await BaseLinkerOrderSnapshot.bulkWrite(records.map((record) => ({
      updateOne: {
        filter: { accountScope, orderId: record.orderId, snapshotHash: record.snapshotHash },
        update: { $setOnInsert: record },
        upsert: true,
      },
    })), { ordered: false });
  } catch (error) {
    // Concurrent writers can observe the same immutable content. Duplicate-key
    // races are harmless; any other write failure crosses the audit boundary.
    const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
    const onlyDuplicates = writeErrors.length > 0 && writeErrors.every((entry) => Number(entry?.code) === 11000);
    if (!onlyDuplicates && Number(error?.code) !== 11000) throw error;
  }
  return records;
}

module.exports = {
  canonicalize,
  baseLinkerOrderSnapshotHash,
  recordBaseLinkerOrderSnapshots,
  ensureSnapshotIndexesReady,
};
