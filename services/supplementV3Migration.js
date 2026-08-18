'use strict';

/**
 * Idempotent V48.S3 structural migration.
 *
 * Goals:
 * - existing modern S2 requests/offers become revision 1;
 * - all historical S2 Waves for the same DeliveryGroup+OrderingSession collapse
 *   to one stable container identity without deleting history rows;
 * - secondary Wave documents are retained as merge tombstones;
 * - no seller/business quantity is invented or recalculated.
 *
 * Safe to run on every boot. The normal critical syncIndexes() runs after this
 * and replaces the old lifetime uniqueness indexes with revision/container ones.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const SupplementWave = require('../models/SupplementWave');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
const { deriveContainerSummary } = require('../utils/supplementState');

function str(v) { return v == null ? '' : String(v); }

function containerKeyFor(deliveryGroupId, orderingSessionId) {
  const raw = `${str(deliveryGroupId)}|${str(orderingSessionId)}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}


async function migrateSupplementV3() {
  // Backfill exact publication generation before replacing the request unique index.
  await SupplementOffer.updateMany(
    { waveId: { $ne: null }, $or: [{ revision: { $exists: false } }, { revision: null }, { revision: { $lt: 1 } }] },
    { $set: { revision: 1 } },
  );
  await SupplementRequest.updateMany(
    { waveId: { $ne: null }, $or: [{ revision: { $exists: false } }, { revision: null }, { revision: { $lt: 1 } }] },
    { $set: { revision: 1 } },
  );

  const waves = await SupplementWave.find(
    { mergedIntoWaveId: null },
    '_id deliveryGroupId orderingSessionId status createdAt notifiedTypes architectureVersion containerKey activityRevision',
  ).sort({ createdAt: 1, _id: 1 }).lean();

  const groups = new Map();
  for (const wave of waves) {
    const gid = str(wave.deliveryGroupId);
    const sid = str(wave.orderingSessionId);
    if (!gid || !sid) continue;
    const key = `${gid}|${sid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(wave);
  }

  let containers = 0;
  let merged = 0;
  for (const groupWaves of groups.values()) {
    const canonical = groupWaves[0];
    const gid = str(canonical.deliveryGroupId);
    const sid = str(canonical.orderingSessionId);
    const containerKey = containerKeyFor(gid, sid);
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        // Re-read under the transaction: another boot worker may have completed
        // the same deterministic merge already.
        const canonicalDoc = await SupplementWave.findById(canonical._id).session(session);
        if (!canonicalDoc) return;

        for (const secondary of groupWaves.slice(1)) {
          const secondaryDoc = await SupplementWave.findById(secondary._id).session(session);
          if (!secondaryDoc || secondaryDoc.mergedIntoWaveId) continue;
          await SupplementOffer.updateMany(
            { waveId: secondaryDoc._id },
            { $set: { waveId: canonicalDoc._id, orderingSessionId: sid, deliveryGroupId: gid } },
            { session },
          );
          await SupplementRequest.updateMany(
            { waveId: secondaryDoc._id },
            { $set: { waveId: canonicalDoc._id, orderingSessionId: sid, deliveryGroupId: gid } },
            { session },
          );
          secondaryDoc.mergedIntoWaveId = canonicalDoc._id;
          secondaryDoc.containerKey = null;
          await secondaryDoc.save({ session });
          merged += 1;
        }

        await SupplementOffer.updateMany(
          { waveId: canonicalDoc._id },
          { $set: { orderingSessionId: sid, deliveryGroupId: gid }, $max: { revision: 1 } },
          { session },
        );
        await SupplementRequest.updateMany(
          { waveId: canonicalDoc._id },
          { $set: { orderingSessionId: sid, deliveryGroupId: gid }, $max: { revision: 1 } },
          { session },
        );

        const offers = await SupplementOffer.find(
          { waveId: canonicalDoc._id },
          'status itemStatus',
        ).session(session).lean();
        const state = deriveContainerSummary(offers);
        canonicalDoc.architectureVersion = 3;
        canonicalDoc.containerKey = containerKey;
        canonicalDoc.status = state;
        canonicalDoc.activityRevision = Math.max(Number(canonicalDoc.activityRevision || 0), offers.length ? 1 : 0);
        if (Array.isArray(canonicalDoc.notifiedTypes) && canonicalDoc.notifiedTypes.includes('opened')) {
          canonicalDoc.openedNotifiedRevision = Math.max(Number(canonicalDoc.openedNotifiedRevision || 0), 1);
        }
        if (Array.isArray(canonicalDoc.notifiedTypes) && canonicalDoc.notifiedTypes.includes('frozen')) {
          canonicalDoc.frozenNotifiedRevision = Math.max(Number(canonicalDoc.frozenNotifiedRevision || 0), 1);
        }
        if (Array.isArray(canonicalDoc.notifiedTypes) && canonicalDoc.notifiedTypes.includes('cancelled')) {
          canonicalDoc.cancelledNotifiedRevision = Math.max(Number(canonicalDoc.cancelledNotifiedRevision || 0), 1);
        }
        await canonicalDoc.save({ session });
      });
      containers += 1;
    } finally {
      await session.endSession();
    }
  }

  return { containers, merged };
}

module.exports = { migrateSupplementV3, containerKeyFor };
