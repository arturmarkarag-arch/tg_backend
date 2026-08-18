'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const SupplementWave = require('../models/SupplementWave');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');
const { getIO } = require('../socket');
const { containerKeyFor } = require('./supplementV3Migration');
const {
  ITEM_STATUS,
  ITEM_RELATION_STATUS,
  REQUEST_STATUS,
  REQUEST_CANCEL_SOURCE,
  ACTIVE_ITEM_STATUSES,
  revisionOf,
  nextRevision,
  blocksGenericRepublish,
  deriveContainerSummary,
} = require('../utils/supplementState');

const ACTIVE_WAVE_STATUSES = SupplementWave.ACTIVE_STATUSES; // legacy compatibility
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

// Legacy S2 idempotency key retained for compatibility scripts/history.
function publicationKeyFor({ deliveryGroupId, orderingSessionId, receiptItemIds }) {
  const raw = [str(deliveryGroupId), str(orderingSessionId), ...[...(receiptItemIds || [])].map(str).sort()].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function isV3Wave(wave) {
  return Number(wave?.architectureVersion || 0) >= 3 && Boolean(wave?.containerKey);
}

async function loadWaveForOffer(offer, { session = null, lean = true } = {}) {
  if (!offer?.waveId) return null;
  let q = SupplementWave.findById(offer.waveId);
  if (session) q = q.session(session);
  return lean ? q.lean() : q;
}

/** V48.S3: item status is authority; V48.S2/legacy may still derive from Wave. */
function effectiveOfferStatus(offer, wave = null) {
  if (!offer) return null;
  if (offer.itemStatus === ITEM_RELATION_STATUS.WITHDRAWN) return ITEM_STATUS.CANCELLED;
  if (isV3Wave(wave)) return offer.status || null;
  return wave?.status || offer.status || null;
}

async function effectiveOfferStatusFromDb(offer, { session = null } = {}) {
  const wave = await loadWaveForOffer(offer, { session, lean: true });
  return { wave, status: effectiveOfferStatus(offer, wave) };
}

function emit(event, payload) { try { getIO()?.emit(event, payload); } catch (_) {} }

function revisionArchiveOf(offer, now = new Date()) {
  return {
    revision: revisionOf(offer),
    status: offer.status || 'cancelled',
    sourceSnapshot: offer.sourceSnapshot || {},
    openedAt: offer.openedAt || null,
    openedBy: str(offer.openedBy),
    openedByName: str(offer.openedByName),
    frozenAt: offer.frozenAt || null,
    frozenBy: str(offer.frozenBy),
    frozenByName: str(offer.frozenByName),
    completedAt: offer.completedAt || null,
    completedBy: str(offer.completedBy),
    completedByName: str(offer.completedByName),
    cancelledAt: offer.cancelledAt || null,
    cancelledBy: str(offer.cancelledBy),
    cancelledByName: str(offer.cancelledByName),
    cancelReason: str(offer.cancelReason || offer.withdrawReason),
    archivedAt: now,
  };
}

function waveSummaryFromOffers(offers) {
  return deriveContainerSummary(offers);
}

async function recomputeWaveSummaryInSession(waveId, { session = null, actor = {}, now = new Date() } = {}) {
  const id = str(waveId);
  if (!id) return null;
  let q = SupplementOffer.find({ waveId: id }, 'status itemStatus').lean();
  if (session) q = q.session(session);
  const offers = await q;
  const status = waveSummaryFromOffers(offers);
  const { by, byName } = actorFields(actor);
  const set = { status };
  if (status === ITEM_STATUS.OPEN) {
    set.completedAt = null;
    set.cancelledAt = null;
    set.cancelReason = '';
  } else if (status === ITEM_STATUS.FROZEN) {
    set.frozenAt = now;
    if (by) set.frozenBy = by;
    if (byName) set.frozenByName = byName;
    set.completedAt = null;
    set.cancelledAt = null;
    set.cancelReason = '';
  } else if (status === ITEM_STATUS.CANCELLED) {
    set.cancelledAt = now;
    if (by) set.cancelledBy = by;
    if (byName) set.cancelledByName = byName;
  } else {
    set.completedAt = now;
    if (by) set.completedBy = by;
    if (byName) set.completedByName = byName;
  }
  let update = SupplementWave.findByIdAndUpdate(id, { $set: set }, { new: true });
  if (session) update = update.session(session);
  return update;
}

async function ensureContainer({ deliveryGroupId, orderingSessionId, actor = {}, now = new Date(), session }) {
  const gid = str(deliveryGroupId);
  const sid = str(orderingSessionId);
  const key = containerKeyFor(gid, sid);
  let wave = await SupplementWave.findOne({ containerKey: key }).session(session);
  if (wave) return wave;

  const { by, byName } = actorFields(actor);
  try {
    [wave] = await SupplementWave.create([{
      deliveryGroupId: gid,
      orderingSessionId: sid,
      architectureVersion: 3,
      containerKey: key,
      status: ITEM_STATUS.COMPLETED, // no active item until this publication transaction adds one
      openedAt: now,
      openedBy: by,
      openedByName: byName,
      activityRevision: 0,
    }], { session });
    return wave;
  } catch (err) {
    if (err?.code !== 11000) throw err;
    wave = await SupplementWave.findOne({ containerKey: key }).session(session);
    if (!wave) throw err;
    return wave;
  }
}

/**
 * Add/restart item slots in the stable group+session container.
 * - never creates a second visible Wave for the same group+session;
 * - open/frozen/current completed items are idempotently skipped;
 * - any cancelled/withdrawn item restarts as revision+1 with a fresh Receipt snapshot;
 * - only completed current/history work stays terminal;
 * - previous request rows remain under their old revision and are never reused.
 */
async function createWaveWithItems({ deliveryGroupId, orderingSessionId, receiptItems, actor = {}, now = new Date(), session }) {
  const rows = receiptItems || [];
  if (!rows.length) return { wave: null, offers: [], changedOffers: [] };
  const wave = await ensureContainer({ deliveryGroupId, orderingSessionId, actor, now, session });
  const { by, byName } = actorFields(actor);
  const itemIds = rows.map((row) => row._id);
  const existing = await SupplementOffer.find({ waveId: wave._id, receiptItemId: { $in: itemIds } }).session(session);
  const byItem = new Map(existing.map((offer) => [str(offer.receiptItemId), offer]));
  const operations = [];
  const changedIds = [];

  for (const item of rows) {
    const current = byItem.get(str(item._id));
    if (!current) {
      operations.push({
        insertOne: {
          document: {
            waveId: wave._id,
            orderingSessionId: str(orderingSessionId),
            receiptId: item.receiptId,
            receiptItemId: item._id,
            productId: item.createdProductId || null,
            deliveryGroupId: str(deliveryGroupId),
            sourceSnapshot: sourceSnapshotFromReceiptItem(item),
            revision: 1,
            revisionHistory: [],
            itemStatus: ITEM_RELATION_STATUS.ACTIVE,
            openedAt: now,
            openedBy: by,
            openedByName: byName,
            status: ITEM_STATUS.OPEN,
            lastReminderAt: now,
          },
        },
      });
      changedIds.push(str(item._id));
      continue;
    }

    // Current active work must never be duplicated. Completed work is immutable;
    // an explicit future "repeat completed" command can be added separately if
    // business ever requires a second fulfilled round in the same session.
    if (blocksGenericRepublish(current)) continue;

    // Cancellation releases the slot even when the previous revision reached
    // FROZEN. Old requests remain archived under that revision and never leak
    // into this clean restart.
    operations.push({
      updateOne: {
        filter: { _id: current._id, revision: revisionOf(current) },
        update: {
          $push: { revisionHistory: revisionArchiveOf(current, now) },
          $set: {
            revision: nextRevision(current),
            productId: item.createdProductId || null,
            sourceSnapshot: sourceSnapshotFromReceiptItem(item),
            itemStatus: ITEM_RELATION_STATUS.ACTIVE,
            withdrawnAt: null,
            withdrawnBy: '',
            withdrawnByName: '',
            withdrawReason: '',
            status: ITEM_STATUS.OPEN,
            openedAt: now,
            openedBy: by,
            openedByName: byName,
            frozenAt: null,
            frozenBy: '',
            frozenByName: '',
            completedAt: null,
            completedBy: null,
            completedByName: '',
            cancelledAt: null,
            cancelledBy: '',
            cancelledByName: '',
            cancelReason: '',
            lockedBy: null,
            lockedAt: null,
            orderingSessionId: str(orderingSessionId),
            deliveryGroupId: str(deliveryGroupId),
          },
        },
      },
    });
    changedIds.push(str(item._id));
  }

  if (operations.length) await SupplementOffer.bulkWrite(operations, { session, ordered: true });

  if (changedIds.length) {
    await SupplementWave.updateOne(
      { _id: wave._id },
      {
        $inc: { activityRevision: 1 },
        $set: {
          architectureVersion: 3,
          status: ITEM_STATUS.OPEN,
          openedAt: now,
          openedBy: by,
          openedByName: byName,
          completedAt: null,
          cancelledAt: null,
          cancelReason: '',
          lastReminderAt: now,
        },
      },
      { session },
    );
  }

  const offers = await SupplementOffer.find({ waveId: wave._id, receiptItemId: { $in: itemIds } }).session(session);
  const changedSet = new Set(changedIds);
  const changedOffers = offers.filter((offer) => changedSet.has(str(offer.receiptItemId)));
  const finalWave = await SupplementWave.findById(wave._id).session(session);
  return { wave: finalWave, offers, changedOffers };
}

/** Freeze only currently OPEN item revisions; already-frozen/completed items stay untouched. */
async function freezeWave(waveId, actor = {}, now = new Date()) {
  const id = str(waveId);
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error('wave not found'), { code: 'supplement_wave_not_found' });
  const { by, byName } = actorFields(actor);
  return withLock(`supplement:wave:${id}`, async () => {
    const mongoSession = await mongoose.connection.startSession();
    let result = null;
    let frozenCount = 0;
    try {
      await mongoSession.withTransaction(async () => {
        const wave = await SupplementWave.findById(id).session(mongoSession);
        if (!wave || wave.mergedIntoWaveId) throw Object.assign(new Error('wave not found'), { code: 'supplement_wave_not_found' });
        if (!isV3Wave(wave)) {
          if (wave.status === ITEM_STATUS.FROZEN) { result = wave; return; }
          if (wave.status !== ITEM_STATUS.OPEN) throw Object.assign(new Error('wave closed'), { code: 'supplement_closed' });
        }
        const write = await SupplementOffer.updateMany(
          { waveId: wave._id, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: ITEM_STATUS.OPEN },
          { $set: { status: ITEM_STATUS.FROZEN, frozenAt: now, frozenBy: by, frozenByName: byName, lockedBy: null, lockedAt: null } },
          { session: mongoSession },
        );
        frozenCount = Number(write.modifiedCount || 0);
        result = await recomputeWaveSummaryInSession(id, { session: mongoSession, actor, now });
      });
    } finally { await mongoSession.endSession(); }

    if (frozenCount > 0 && result) {
      const payload = { waveId: id, deliveryGroupId: str(result.deliveryGroupId), orderingSessionId: str(result.orderingSessionId), status: result.status, frozenCount };
      emit('supplement_wave_frozen', payload);
      emit('supplement_wave_changed', payload);
      emit('supplement_frozen', { waveId: id, deliveryGroupId: str(result.deliveryGroupId), frozenCount });
    }
    if (result) result._v3TransitionCount = frozenCount;
    return result;
  }, { ttlMs: 10_000, waitMs: 5_000 });
}

async function cancelOfferRevision(offerId, actor = {}, reason = 'cancelled_by_staff', now = new Date()) {
  const id = str(offerId);
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error('offer not found'), { code: 'supplement_offer_not_found' });
  const { by, byName } = actorFields(actor);
  return withLock(`supplement:${id}`, async () => {
    const mongoSession = await mongoose.connection.startSession();
    let result = null;
    let cancelledRequestIds = [];
    try {
      await mongoSession.withTransaction(async () => {
        const offer = await SupplementOffer.findById(id).session(mongoSession);
        if (!offer) throw Object.assign(new Error('offer not found'), { code: 'supplement_offer_not_found' });
        if (offer.itemStatus === ITEM_RELATION_STATUS.WITHDRAWN || offer.status === ITEM_STATUS.CANCELLED) { result = offer; return; }
        if (offer.status === ITEM_STATUS.COMPLETED) throw Object.assign(new Error('completed item is immutable'), { code: 'supplement_closed' });
        if (!ACTIVE_ITEM_STATUSES.includes(offer.status)) throw Object.assign(new Error('offer closed'), { code: 'supplement_closed' });

        const revision = revisionOf(offer);
        const pending = await SupplementRequest.find({ offerId: offer._id, revision, status: REQUEST_STATUS.ACTIVE, packed: false }, '_id').session(mongoSession).lean();
        cancelledRequestIds = pending.map((r) => str(r._id));
        if (pending.length) {
          await SupplementRequest.updateMany(
            { _id: { $in: pending.map((r) => r._id) }, revision, status: REQUEST_STATUS.ACTIVE, packed: false },
            {
              $set: { status: REQUEST_STATUS.CANCELLED, cancelledAt: now, cancelledBy: by, cancelledByName: byName, cancelReason: str(reason), cancelSource: REQUEST_CANCEL_SOURCE.STAFF },
              $push: { history: { at: now, by, byName, action: 'cancelled', meta: { reason: str(reason), staffCancelled: true, revision } } },
            },
            { session: mongoSession },
          );
        }
        offer.status = ITEM_STATUS.CANCELLED;
        offer.cancelledAt = now;
        offer.cancelledBy = by;
        offer.cancelledByName = byName;
        offer.cancelReason = str(reason);
        offer.lockedBy = null;
        offer.lockedAt = null;
        await offer.save({ session: mongoSession });
        await recomputeWaveSummaryInSession(offer.waveId, { session: mongoSession, actor, now });
        result = offer;
      });
    } finally { await mongoSession.endSession(); }

    if (result) {
      const payload = { offerId: id, waveId: result.waveId ? str(result.waveId) : null, deliveryGroupId: str(result.deliveryGroupId), orderingSessionId: result.orderingSessionId || null, revision: Number(result.revision || 1), status: result.status, cancelledRequestIds };
      emit('supplement_item_cancelled', payload);
      emit('supplement_wave_changed', payload);
    }
    return result;
  }, { ttlMs: 10_000, waitMs: 5_000 });
}

/** Cancel all CURRENT open/frozen item revisions in the container. Container stays reusable. */
async function cancelWave(waveId, actor = {}, reason = 'cancelled_by_admin', now = new Date()) {
  const id = str(waveId);
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error('wave not found'), { code: 'supplement_wave_not_found' });
  const { by, byName } = actorFields(actor);
  return withLock(`supplement:wave:${id}`, async () => {
    const mongoSession = await mongoose.connection.startSession();
    let result = null;
    let cancelledItems = 0;
    try {
      await mongoSession.withTransaction(async () => {
        const wave = await SupplementWave.findById(id).session(mongoSession);
        if (!wave || wave.mergedIntoWaveId) throw Object.assign(new Error('wave not found'), { code: 'supplement_wave_not_found' });
        const offers = await SupplementOffer.find({ waveId: wave._id, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: { $in: ACTIVE_ITEM_STATUSES } }).session(mongoSession);
        for (const offer of offers) {
          const revision = revisionOf(offer);
          await SupplementRequest.updateMany(
            { offerId: offer._id, revision, status: REQUEST_STATUS.ACTIVE, packed: false },
            {
              $set: { status: REQUEST_STATUS.CANCELLED, cancelledAt: now, cancelledBy: by, cancelledByName: byName, cancelReason: str(reason), cancelSource: REQUEST_CANCEL_SOURCE.STAFF },
              $push: { history: { at: now, by, byName, action: 'cancelled', meta: { reason: str(reason), waveCancelled: true, revision } } },
            },
            { session: mongoSession },
          );
          offer.status = ITEM_STATUS.CANCELLED;
          offer.cancelledAt = now;
          offer.cancelledBy = by;
          offer.cancelledByName = byName;
          offer.cancelReason = str(reason);
          offer.lockedBy = null;
          offer.lockedAt = null;
          await offer.save({ session: mongoSession });
          cancelledItems += 1;
        }
        result = await recomputeWaveSummaryInSession(id, { session: mongoSession, actor, now });
        if (result && cancelledItems) {
          result.cancelReason = str(reason);
          await result.save({ session: mongoSession });
        }
      });
    } finally { await mongoSession.endSession(); }

    if (result && cancelledItems) {
      const payload = { waveId: id, deliveryGroupId: str(result.deliveryGroupId), orderingSessionId: str(result.orderingSessionId), status: result.status, cancelledItems };
      emit('supplement_wave_cancelled', payload);
      emit('supplement_wave_changed', payload);
      emit('supplement_completed', { waveId: id, deliveryGroupId: str(result.deliveryGroupId), cancelled: true });
    }
    if (result) result._v3TransitionCount = cancelledItems;
    return result;
  }, { ttlMs: 10_000, waitMs: 5_000 });
}

/**
 * Route correction: cancel only current non-terminal item revisions derived from
 * this ReceiptItem. Packed facts remain. Wave summary is recomputed INSIDE the
 * same transaction, eliminating the old post-commit crash window.
 */
async function withdrawReceiptItemFromActiveWaves({ receiptItemId, actor = {}, reason = 'routing_corrected', session = null, now = new Date() }) {
  let q = SupplementOffer.find({ receiptItemId, waveId: { $ne: null }, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: { $in: ACTIVE_ITEM_STATUSES } });
  if (session) q = q.session(session);
  const offers = await q;
  if (!offers.length) return { waveIds: [], alreadyFulfilledShopIds: [], cancelledRequestIds: [] };

  const { by, byName } = actorFields(actor);
  const packedShopIds = new Set();
  const cancelledRequestIds = [];
  const waveIds = new Set();

  for (const offer of offers) {
    const revision = revisionOf(offer);
    let rq = SupplementRequest.find({ offerId: offer._id, revision, status: REQUEST_STATUS.ACTIVE });
    if (session) rq = rq.session(session);
    const requests = await rq;
    const packed = requests.filter((r) => r.packed);
    const unpacked = requests.filter((r) => !r.packed);
    packed.forEach((r) => packedShopIds.add(str(r.shopId)));
    cancelledRequestIds.push(...unpacked.map((r) => str(r._id)));
    if (unpacked.length) {
      await SupplementRequest.updateMany(
        { _id: { $in: unpacked.map((r) => r._id) }, revision, packed: false },
        {
          $set: { status: REQUEST_STATUS.CANCELLED, cancelledAt: now, cancelledBy: by, cancelledByName: byName, cancelReason: reason, cancelSource: REQUEST_CANCEL_SOURCE.SYSTEM },
          $push: { history: { at: now, by, byName, action: 'cancelled', meta: { reason, correction: true, revision } } },
        },
        session ? { session } : undefined,
      );
    }
    offer.itemStatus = 'withdrawn';
    offer.withdrawnAt = now;
    offer.withdrawnBy = by;
    offer.withdrawnByName = byName;
    offer.withdrawReason = reason;
    offer.status = ITEM_STATUS.CANCELLED;
    offer.cancelledAt = now;
    offer.cancelledBy = by;
    offer.cancelledByName = byName;
    offer.cancelReason = reason;
    offer.lockedBy = null;
    offer.lockedAt = null;
    await offer.save(session ? { session } : undefined);
    waveIds.add(str(offer.waveId));
  }

  for (const waveId of waveIds) await recomputeWaveSummaryInSession(waveId, { session, actor, now });
  return { waveIds: [...waveIds], alreadyFulfilledShopIds: [...packedShopIds], cancelledRequestIds };
}

async function recomputeWaveCompletion(waveId, actor = {}, now = new Date()) {
  return withLock(`supplement:wave:${str(waveId)}`, () => recomputeWaveSummaryInSession(waveId, { actor, now }), { ttlMs: 10_000, waitMs: 5_000 });
}

async function countActiveWavesForSession(orderingSessionId) {
  if (!orderingSessionId) return 0;
  const ids = await SupplementOffer.distinct('waveId', {
    orderingSessionId: str(orderingSessionId),
    waveId: { $ne: null },
    itemStatus: ITEM_RELATION_STATUS.ACTIVE,
    status: { $in: ACTIVE_ITEM_STATUSES },
  });
  return ids.filter(Boolean).length;
}

async function findActiveWavesForSession(orderingSessionId) {
  if (!orderingSessionId) return [];
  const ids = await SupplementOffer.distinct('waveId', {
    orderingSessionId: str(orderingSessionId),
    waveId: { $ne: null },
    itemStatus: ITEM_RELATION_STATUS.ACTIVE,
    status: { $in: ACTIVE_ITEM_STATUSES },
  });
  if (!ids.length) return [];
  return SupplementWave.find({ _id: { $in: ids }, mergedIntoWaveId: null }).sort({ openedAt: 1 }).lean();
}

module.exports = {
  ACTIVE_WAVE_STATUSES,
  TERMINAL_WAVE_STATUSES,
  ACTIVE_ITEM_STATUSES,
  sourceSnapshotFromReceiptItem,
  publicationKeyFor,
  isV3Wave,
  loadWaveForOffer,
  effectiveOfferStatus,
  effectiveOfferStatusFromDb,
  revisionArchiveOf,
  waveSummaryFromOffers,
  recomputeWaveSummaryInSession,
  createWaveWithItems,
  freezeWave,
  cancelOfferRevision,
  cancelWave,
  recomputeWaveCompletion,
  withdrawReceiptItemFromActiveWaves,
  countActiveWavesForSession,
  findActiveWavesForSession,
};
