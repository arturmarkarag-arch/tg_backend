'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const SupplementWave = require('../models/SupplementWave');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
const ReceiptItem = require('../models/ReceiptItem');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');
const { getIO } = require('../socket');

const ACTIVE_WAVE_STATUSES = SupplementWave.ACTIVE_STATUSES;
const TERMINAL_WAVE_STATUSES = SupplementWave.TERMINAL_STATUSES;

function str(v) { return v == null ? '' : String(v); }

function actorFields(actor = {}) {
  return {
    by: str(actor.by || actor.telegramId),
    byName: str(actor.byName || [actor.firstName, actor.lastName].filter(Boolean).join(' ')),
  };
}

function sourceSnapshotFromReceiptItem(item) {
  return {
    title: item?.name || '',
    imageUrl: item?.photoUrl || '',
    originalImageUrl: item?.originalPhotoUrl || '',
    price: Number(item?.price || 0),
    quantityPerPackage: Number(item?.qtyPerPackage || 0),
    aiDescription: item?.aiDescription || '',
  };
}

function publicationKeyFor({ deliveryGroupId, orderingSessionId, receiptItemIds }) {
  const raw = [
    str(deliveryGroupId),
    str(orderingSessionId),
    ...[...(receiptItemIds || [])].map(str).sort(),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function loadWaveForOffer(offer, { session = null, lean = true } = {}) {
  if (!offer?.waveId) return null;
  let q = SupplementWave.findById(offer.waveId);
  if (session) q = q.session(session);
  return lean ? q.lean() : q;
}

function effectiveOfferStatus(offer, wave = null) {
  if (!offer) return null;
  if (offer.itemStatus === 'withdrawn') return 'cancelled';
  return wave?.status || offer.status || null;
}

async function effectiveOfferStatusFromDb(offer, { session = null } = {}) {
  const wave = await loadWaveForOffer(offer, { session, lean: true });
  return { wave, status: effectiveOfferStatus(offer, wave) };
}

function isSellerEditableStatus(status) {
  return status === 'open';
}

function isPackingStatus(status) {
  return status === 'frozen';
}

function emit(event, payload) {
  try { getIO()?.emit(event, payload); } catch (_) {}
}

/**
 * Creates one Wave and one child SupplementOffer per selected ReceiptItem.
 * Must be called inside the publication transaction.
 */
async function createWaveWithItems({
  deliveryGroupId,
  orderingSessionId,
  receiptItems,
  actor = {},
  now = new Date(),
  session,
}) {
  const rows = receiptItems || [];
  if (!rows.length) return { wave: null, offers: [] };
  const { by, byName } = actorFields(actor);
  const publicationKey = publicationKeyFor({
    deliveryGroupId,
    orderingSessionId,
    receiptItemIds: rows.map((row) => row._id),
  });

  let wave = await SupplementWave.findOne({ publicationKey }).session(session);
  if (!wave) {
    [wave] = await SupplementWave.create([{
      deliveryGroupId: str(deliveryGroupId),
      orderingSessionId: str(orderingSessionId),
      status: 'open',
      openedAt: now,
      openedBy: by,
      openedByName: byName,
      publicationKey,
      lastReminderAt: now,
    }], { session });
  }

  // One Wave can contain tens/hundreds of items. Do not turn publication into
  // N read + N insert round-trips. Pre-read existing compatibility rows once,
  // bulk-upsert the missing/current rows, then read the final child set once.
  const itemIds = rows.map((item) => item._id);
  const existing = await SupplementOffer.find({
    receiptItemId: { $in: itemIds },
    deliveryGroupId: str(deliveryGroupId),
  }).session(session);
  const existingByItem = new Map(existing.map((offer) => [str(offer.receiptItemId), offer]));
  const operations = [];

  for (const item of rows) {
    const current = existingByItem.get(str(item._id));
    if (current?.waveId && str(current.waveId) !== str(wave._id)) {
      throw appError('supplement_item_already_published');
    }

    if (current && !current.waveId) {
      // Forward-compatibility for a row inserted by an interrupted/legacy rollout.
      operations.push({
        updateOne: {
          filter: { _id: current._id, waveId: null },
          update: {
            $set: {
              waveId: wave._id,
              orderingSessionId: str(orderingSessionId),
              sourceSnapshot: sourceSnapshotFromReceiptItem(item),
            },
          },
        },
      });
      continue;
    }

    if (!current) {
      operations.push({
        updateOne: {
          filter: {
            receiptItemId: item._id,
            deliveryGroupId: str(deliveryGroupId),
          },
          update: {
            $setOnInsert: {
              waveId: wave._id,
              orderingSessionId: str(orderingSessionId),
              receiptId: item.receiptId,
              receiptItemId: item._id,
              productId: item.createdProductId || null,
              deliveryGroupId: str(deliveryGroupId),
              sourceSnapshot: sourceSnapshotFromReceiptItem(item),
              itemStatus: 'active',
              openedAt: now,
              status: 'open', // compatibility mirror
              lastReminderAt: now,
            },
          },
          upsert: true,
        },
      });
    }
  }

  if (operations.length) {
    await SupplementOffer.bulkWrite(operations, { session, ordered: true });
  }

  const offers = await SupplementOffer.find({
    receiptItemId: { $in: itemIds },
    deliveryGroupId: str(deliveryGroupId),
    waveId: wave._id,
  }).session(session);
  if (offers.length !== rows.length) {
    throw appError('supplement_wave_items_incomplete');
  }

  return { wave, offers };
}

async function freezeWave(waveId, actor = {}, now = new Date()) {
  const id = str(waveId);
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw Object.assign(new Error('wave not found'), { code: 'supplement_wave_not_found' });
  }
  const { by, byName } = actorFields(actor);

  return withLock(`supplement:wave:${id}`, async () => {
    const mongoSession = await mongoose.connection.startSession();
    let result = null;
    let transitioned = false;
    try {
      await mongoSession.withTransaction(async () => {
        const existing = await SupplementWave.findById(id).session(mongoSession);
        if (!existing) throw Object.assign(new Error('wave not found'), { code: 'supplement_wave_not_found' });
        if (existing.status === 'frozen') {
          result = existing;
          return;
        }
        if (existing.status !== 'open') {
          throw Object.assign(new Error('wave closed'), { code: 'supplement_closed' });
        }

        existing.status = 'frozen';
        existing.frozenAt = now;
        existing.frozenBy = by;
        existing.frozenByName = byName;
        await existing.save({ session: mongoSession });

        // The Wave is the lifecycle authority, but child status remains as a
        // compatibility mirror for old readers. Root + mirrors transition in one
        // transaction so a restart cannot leave an OPEN child under a FROZEN Wave.
        await SupplementOffer.updateMany(
          { waveId: existing._id, itemStatus: 'active', status: 'open' },
          { $set: { status: 'frozen', frozenAt: now, frozenBy: by, frozenByName: byName } },
          { session: mongoSession },
        );
        result = existing;
        transitioned = true;
      });
    } finally {
      await mongoSession.endSession();
    }

    if (transitioned && result) {
      const frozenPayload = {
        waveId: id,
        deliveryGroupId: str(result.deliveryGroupId),
        orderingSessionId: str(result.orderingSessionId),
        status: 'frozen',
      };
      emit('supplement_wave_frozen', frozenPayload);
      emit('supplement_wave_changed', frozenPayload);
      // legacy client event during rollout
      emit('supplement_frozen', { waveId: id, deliveryGroupId: str(result.deliveryGroupId) });
    }
    return result;
  }, { ttlMs: 10_000, waitMs: 5_000 });
}

async function recomputeWaveCompletion(waveId, actor = {}, now = new Date()) {
  const id = str(waveId);
  if (!id) return null;
  return withLock(`supplement:wave:${id}`, async () => {
    const wave = await SupplementWave.findById(id);
    if (!wave || TERMINAL_WAVE_STATUSES.includes(wave.status)) return wave;
    if (wave.status !== 'frozen') return wave;

    const activeItems = await SupplementOffer.find({
      waveId: wave._id,
      itemStatus: 'active',
    }, '_id status').lean();

    if (activeItems.some((item) => item.status !== 'completed')) return wave;

    const { by, byName } = actorFields(actor);
    const completed = await SupplementWave.findOneAndUpdate(
      { _id: wave._id, status: 'frozen' },
      { $set: { status: 'completed', completedAt: now, completedBy: by, completedByName: byName } },
      { new: true },
    );
    if (completed) {
      const completedPayload = {
        waveId: id,
        deliveryGroupId: str(completed.deliveryGroupId),
        orderingSessionId: str(completed.orderingSessionId),
        status: 'completed',
      };
      emit('supplement_wave_completed', completedPayload);
      emit('supplement_wave_changed', completedPayload);
      emit('supplement_completed', { waveId: id, deliveryGroupId: str(completed.deliveryGroupId) });
    }
    return completed || wave;
  }, { ttlMs: 10_000, waitMs: 5_000 });
}

/**
 * Compensating withdrawal for a wrong ReceiptItem route.
 * Packed rows remain physical facts; active/unpacked requests become cancelled.
 */
async function withdrawReceiptItemFromActiveWaves({ receiptItemId, actor = {}, reason = 'routing_corrected', session = null, now = new Date() }) {
  const query = SupplementOffer.find({
    receiptItemId,
    waveId: { $ne: null },
    itemStatus: 'active',
  });
  if (session) query.session(session);
  const offers = await query;
  if (!offers.length) return { waveIds: [], alreadyFulfilledShopIds: [], cancelledRequestIds: [] };

  const waveIds = [...new Set(offers.map((o) => str(o.waveId)).filter(Boolean))];
  let wavesQ = SupplementWave.find({ _id: { $in: waveIds }, status: { $in: ACTIVE_WAVE_STATUSES } });
  if (session) wavesQ = wavesQ.session(session);
  const activeWaves = await wavesQ.lean();
  const activeWaveIds = new Set(activeWaves.map((w) => str(w._id)));
  const activeOffers = offers.filter((o) => activeWaveIds.has(str(o.waveId)));
  if (!activeOffers.length) return { waveIds: [], alreadyFulfilledShopIds: [], cancelledRequestIds: [] };

  const offerIds = activeOffers.map((o) => o._id);
  let requestsQ = SupplementRequest.find({ offerId: { $in: offerIds }, status: { $ne: 'cancelled' } });
  if (session) requestsQ = requestsQ.session(session);
  const requests = await requestsQ;
  const packed = requests.filter((r) => r.packed);
  const unpacked = requests.filter((r) => !r.packed);
  const { by, byName } = actorFields(actor);

  if (unpacked.length) {
    const opts = session ? { session } : undefined;
    await SupplementRequest.updateMany(
      { _id: { $in: unpacked.map((r) => r._id) }, packed: false },
      {
        $set: {
          status: 'cancelled', cancelledAt: now,
          cancelledBy: by, cancelledByName: byName,
          cancelReason: reason,
        },
        $push: { history: { at: now, by, byName, action: 'cancelled', meta: { reason, correction: true } } },
      },
      opts,
    );
  }

  for (const offer of activeOffers) {
    offer.itemStatus = 'withdrawn';
    offer.withdrawnAt = now;
    offer.withdrawnBy = by;
    offer.withdrawnByName = byName;
    offer.withdrawReason = reason;
    offer.status = 'cancelled';
    offer.lockedBy = null;
    offer.lockedAt = null;
    await offer.save(session ? { session } : undefined);
  }

  return {
    waveIds: [...new Set(activeOffers.map((o) => str(o.waveId)))],
    alreadyFulfilledShopIds: [...new Set(packed.map((r) => str(r.shopId)))],
    cancelledRequestIds: unpacked.map((r) => str(r._id)),
  };
}

async function cancelWave(waveId, actor = {}, reason = 'cancelled_by_admin', now = new Date()) {
  const id = str(waveId);
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw Object.assign(new Error('wave not found'), { code: 'supplement_wave_not_found' });
  }
  const { by, byName } = actorFields(actor);

  return withLock(`supplement:wave:${id}`, async () => {
    const mongoSession = await mongoose.connection.startSession();
    let result = null;
    let transitioned = false;
    try {
      await mongoSession.withTransaction(async () => {
        const wave = await SupplementWave.findById(id).session(mongoSession);
        if (!wave) throw Object.assign(new Error('wave not found'), { code: 'supplement_wave_not_found' });
        if (wave.status === 'completed' || wave.status === 'cancelled') {
          result = wave;
          return;
        }

        const offers = await SupplementOffer.find(
          { waveId: wave._id, itemStatus: 'active' },
          '_id',
        ).session(mongoSession).lean();
        const offerIds = offers.map((offer) => offer._id);
        if (offerIds.length) {
          // Physical facts are immutable: packed rows stay packed/fulfilled.
          // Only unfinished demand is cancelled.
          await SupplementRequest.updateMany(
            { offerId: { $in: offerIds }, status: { $ne: 'cancelled' }, packed: false },
            {
              $set: {
                status: 'cancelled',
                cancelledAt: now,
                cancelledBy: by,
                cancelledByName: byName,
                cancelReason: reason,
              },
              $push: { history: { at: now, by, byName, action: 'cancelled', meta: { reason, waveCancelled: true } } },
            },
            { session: mongoSession },
          );
          await SupplementOffer.updateMany(
            { _id: { $in: offerIds }, status: { $in: ['open', 'frozen'] } },
            { $set: { status: 'cancelled', lockedBy: null, lockedAt: null } },
            { session: mongoSession },
          );
        }

        wave.status = 'cancelled';
        wave.cancelledAt = now;
        wave.cancelledBy = by;
        wave.cancelledByName = byName;
        wave.cancelReason = str(reason);
        await wave.save({ session: mongoSession });
        result = wave;
        transitioned = true;
      });
    } finally {
      await mongoSession.endSession();
    }

    if (transitioned && result) {
      const cancelledPayload = {
        waveId: id,
        deliveryGroupId: str(result.deliveryGroupId),
        orderingSessionId: str(result.orderingSessionId),
        status: 'cancelled',
      };
      emit('supplement_wave_cancelled', cancelledPayload);
      emit('supplement_wave_changed', cancelledPayload);
      emit('supplement_completed', { waveId: id, deliveryGroupId: str(result.deliveryGroupId), cancelled: true });
    }
    return result;
  }, { ttlMs: 10_000, waitMs: 5_000 });
}

async function completeAffectedWaves(waveIds = [], actor = {}) {
  for (const waveId of [...new Set(waveIds.map(str).filter(Boolean))]) {
    const wave = await SupplementWave.findById(waveId);
    if (!wave || TERMINAL_WAVE_STATUSES.includes(wave.status)) continue;
    const active = await SupplementOffer.find({ waveId, itemStatus: 'active' }, '_id status').lean();

    // A compensating route correction can withdraw the last item while a Wave is
    // still OPEN. Leaving that aggregate open forever would block session closure.
    // No physical work remains, so close the empty publication as cancelled.
    if (!active.length) {
      const { by, byName } = actorFields(actor);
      const now = new Date();
      const cancelled = await SupplementWave.findOneAndUpdate(
        { _id: waveId, status: { $in: ACTIVE_WAVE_STATUSES } },
        {
          $set: {
            status: 'cancelled',
            cancelledAt: now,
            cancelledBy: by || 'system:routing-correction',
            cancelledByName: byName,
            cancelReason: 'all_items_withdrawn',
          },
        },
        { new: true },
      );
      if (cancelled) {
        const cancelledPayload = {
          waveId: str(cancelled._id),
          deliveryGroupId: str(cancelled.deliveryGroupId),
          orderingSessionId: str(cancelled.orderingSessionId),
          status: 'cancelled',
          reason: 'all_items_withdrawn',
        };
        emit('supplement_wave_cancelled', cancelledPayload);
        emit('supplement_wave_changed', cancelledPayload);
      }
      continue;
    }

    if (active.every((o) => o.status === 'completed')) {
      await recomputeWaveCompletion(waveId, actor).catch(() => {});
    }
  }
}

async function countActiveWavesForSession(orderingSessionId) {
  if (!orderingSessionId) return 0;
  return SupplementWave.countDocuments({
    orderingSessionId: str(orderingSessionId),
    status: { $in: ACTIVE_WAVE_STATUSES },
  });
}

async function findActiveWavesForSession(orderingSessionId) {
  if (!orderingSessionId) return [];
  return SupplementWave.find({
    orderingSessionId: str(orderingSessionId),
    status: { $in: ACTIVE_WAVE_STATUSES },
  }).sort({ openedAt: 1 }).lean();
}

module.exports = {
  ACTIVE_WAVE_STATUSES,
  TERMINAL_WAVE_STATUSES,
  sourceSnapshotFromReceiptItem,
  publicationKeyFor,
  loadWaveForOffer,
  effectiveOfferStatus,
  effectiveOfferStatusFromDb,
  isSellerEditableStatus,
  isPackingStatus,
  createWaveWithItems,
  freezeWave,
  cancelWave,
  recomputeWaveCompletion,
  withdrawReceiptItemFromActiveWaves,
  completeAffectedWaves,
  countActiveWavesForSession,
  findActiveWavesForSession,
};
