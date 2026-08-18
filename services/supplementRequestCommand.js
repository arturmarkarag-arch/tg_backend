'use strict';

const mongoose = require('mongoose');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
const { withOfferLock } = require('./supplementOffers');
const { appError } = require('../utils/errors');
const { ITEM_STATUS, ITEM_RELATION_STATUS, REQUEST_STATUS, REQUEST_CANCEL_SOURCE, revisionOf, sellerMayRestoreRequest } = require('../utils/supplementState');

function str(v) { return v == null ? '' : String(v); }

function assertSellerContext(offer, ctx) {
  if (!offer) throw appError('supplement_offer_not_found');
  if (offer.itemStatus === ITEM_RELATION_STATUS.WITHDRAWN) throw appError('supplement_closed');
  if (str(offer.deliveryGroupId) !== str(ctx.deliveryGroupId)) throw appError('supplement_wrong_group');
  if (offer.orderingSessionId && str(offer.orderingSessionId) !== str(ctx.orderingSessionId)) throw appError('supplement_wrong_group');
  if (offer.status !== ITEM_STATUS.OPEN) throw appError('supplement_closed');
}

function validateQuantity(quantity, { min = 1, max = 6 } = {}) {
  const value = Math.trunc(Number(quantity));
  if (!Number.isFinite(value) || value < min || value > max) throw appError('supplement_quantity_invalid');
  return value;
}

async function createSellerRequest({ offerId, ctx, quantity, actor, min = 1, max = 6 }) {
  const value = validateQuantity(quantity, { min, max });
  return withOfferLock(offerId, async () => {
    const offer = await SupplementOffer.findById(offerId);
    assertSellerContext(offer, ctx);
    const revision = revisionOf(offer);
    let existing = await SupplementRequest.findOne({ offerId: offer._id, revision, shopId: ctx.shopId });
    if (existing?.packed) throw appError('supplement_request_locked');
    if (existing?.status === REQUEST_STATUS.ACTIVE) throw appError('supplement_request_exists');

    if (existing) {
      if (!sellerMayRestoreRequest(existing)) throw appError('supplement_request_staff_cancelled');
      existing.status = REQUEST_STATUS.ACTIVE;
      existing.quantity = value;
      existing.cancelledAt = null;
      existing.cancelledBy = '';
      existing.cancelledByName = '';
      existing.cancelReason = '';
      existing.cancelSource = '';
      existing.updatedBy = actor.by;
      existing.updatedByName = actor.byName;
      existing.history.push({ ...actor, at: new Date(), action: 'restored', meta: { to: value, revision } });
      await existing.save();
      return { action: 'created', request: existing, offer };
    }

    try {
      existing = await SupplementRequest.create({
        waveId: offer.waveId || null,
        orderingSessionId: offer.orderingSessionId || null,
        offerId: offer._id,
        revision,
        shopId: ctx.shopId,
        shopName: ctx.shopName,
        deliveryGroupId: ctx.deliveryGroupId,
        quantity: value,
        status: REQUEST_STATUS.ACTIVE,
        createdBy: actor.by,
        createdByName: actor.byName,
        updatedBy: actor.by,
        updatedByName: actor.byName,
        history: [{ ...actor, action: 'created', meta: { quantity: value, revision } }],
      });
      return { action: 'created', request: existing, offer };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      // A concurrent CREATE won. Do not silently turn CREATE into UPDATE.
      throw appError('supplement_request_exists');
    }
  });
}

async function updateSellerRequest({ requestId, ctx, quantity, actor, min = 1, max = 6 }) {
  const value = validateQuantity(quantity, { min, max });
  const head = await SupplementRequest.findById(requestId, 'offerId revision shopId status packed').lean();
  if (!head || str(head.shopId) !== str(ctx.shopId)) throw appError('supplement_request_not_found');
  return withOfferLock(head.offerId, async () => {
    const offer = await SupplementOffer.findById(head.offerId);
    assertSellerContext(offer, ctx);
    const revision = revisionOf(offer);
    if (revisionOf(head) !== revision) throw appError('supplement_request_not_found');
    const request = await SupplementRequest.findOne({ _id: requestId, offerId: offer._id, revision, shopId: ctx.shopId });
    if (!request || request.status !== REQUEST_STATUS.ACTIVE) throw appError('supplement_request_not_found');
    if (request.packed) throw appError('supplement_request_locked');
    const from = Number(request.quantity || 0);
    if (from === value) return { action: 'noop', request, offer };
    request.quantity = value;
    request.updatedBy = actor.by;
    request.updatedByName = actor.byName;
    request.history.push({ ...actor, at: new Date(), action: 'quantity_changed', meta: { from, to: value, revision } });
    await request.save();
    return { action: 'updated', request, offer };
  });
}

async function cancelSellerRequest({ requestId, ctx, actor }) {
  const head = await SupplementRequest.findById(requestId, 'offerId revision shopId status packed').lean();
  if (!head || str(head.shopId) !== str(ctx.shopId)) throw appError('supplement_request_not_found');
  return withOfferLock(head.offerId, async () => {
    const offer = await SupplementOffer.findById(head.offerId);
    assertSellerContext(offer, ctx);
    const revision = revisionOf(offer);
    if (revisionOf(head) !== revision) throw appError('supplement_request_not_found');
    const request = await SupplementRequest.findOne({ _id: requestId, offerId: offer._id, revision, shopId: ctx.shopId });
    if (!request || request.status === REQUEST_STATUS.CANCELLED) return { action: 'noop', request, offer };
    if (request.packed) throw appError('supplement_request_locked');
    const now = new Date();
    request.status = REQUEST_STATUS.CANCELLED;
    request.cancelledAt = now;
    request.cancelledBy = actor.by;
    request.cancelledByName = actor.byName;
    request.cancelReason = 'seller_cancelled';
    request.cancelSource = REQUEST_CANCEL_SOURCE.SELLER;
    request.updatedBy = actor.by;
    request.updatedByName = actor.byName;
    request.history.push({ ...actor, at: now, action: 'cancelled', meta: { reason: 'seller_cancelled', revision } });
    await request.save();
    return { action: 'cancelled', request, offer };
  });
}

async function cancelRequestByStaff({ requestId, actor, reason = 'cancelled_by_staff' }) {
  if (!mongoose.Types.ObjectId.isValid(str(requestId))) throw appError('supplement_request_not_found');
  const head = await SupplementRequest.findById(requestId, 'offerId revision status packed').lean();
  if (!head) throw appError('supplement_request_not_found');
  return withOfferLock(head.offerId, async () => {
    const offer = await SupplementOffer.findById(head.offerId);
    if (!offer) throw appError('supplement_offer_not_found');
    const revision = revisionOf(offer);
    if (revisionOf(head) !== revision) throw appError('supplement_request_not_found');
    const request = await SupplementRequest.findOne({ _id: requestId, offerId: offer._id, revision });
    if (!request) throw appError('supplement_request_not_found');
    if (request.packed) return { action: 'packed_preserved', request, offer };
    if (![ITEM_STATUS.OPEN, ITEM_STATUS.FROZEN].includes(offer.status)) throw appError('supplement_closed');
    // Staff cancellation is an authority decision, not merely a status toggle.
    // If the seller had already cancelled the row, staff may still make that
    // cancellation authoritative so the seller role cannot resurrect it later.
    const wasCancelled = request.status === REQUEST_STATUS.CANCELLED;
    const alreadyStaffCancelled = wasCancelled && request.cancelSource === REQUEST_CANCEL_SOURCE.STAFF;
    if (alreadyStaffCancelled) return { action: 'noop', request, offer };
    const now = new Date();
    request.status = REQUEST_STATUS.CANCELLED;
    request.cancelledAt = now;
    request.cancelledBy = actor.by;
    request.cancelledByName = actor.byName;
    request.cancelReason = str(reason);
    request.cancelSource = REQUEST_CANCEL_SOURCE.STAFF;
    request.updatedBy = actor.by;
    request.updatedByName = actor.byName;
    request.history.push({ ...actor, at: now, action: wasCancelled ? 'staff_cancel_enforced' : 'cancelled', meta: { reason: str(reason), staffCancelled: true, revision } });
    await request.save();
    return { action: wasCancelled ? 'staff_cancel_enforced' : 'cancelled', request, offer };
  });
}

async function restoreRequestByStaff({ requestId, actor }) {
  if (!mongoose.Types.ObjectId.isValid(str(requestId))) throw appError('supplement_request_not_found');
  const head = await SupplementRequest.findById(requestId, 'offerId revision status packed cancelSource').lean();
  if (!head) throw appError('supplement_request_not_found');
  return withOfferLock(head.offerId, async () => {
    const offer = await SupplementOffer.findById(head.offerId);
    if (!offer) throw appError('supplement_offer_not_found');
    const revision = revisionOf(offer);
    if (revisionOf(head) !== revision) throw appError('supplement_request_not_found');
    if (offer.status !== ITEM_STATUS.OPEN || offer.itemStatus === ITEM_RELATION_STATUS.WITHDRAWN) throw appError('supplement_closed');
    const request = await SupplementRequest.findOne({ _id: requestId, offerId: offer._id, revision });
    if (!request) throw appError('supplement_request_not_found');
    if (request.status === REQUEST_STATUS.ACTIVE) return { action: 'noop', request, offer };
    if (request.packed) throw appError('supplement_request_locked');
    if (request.cancelSource !== REQUEST_CANCEL_SOURCE.STAFF) throw appError('supplement_request_not_found');
    const now = new Date();
    request.status = REQUEST_STATUS.ACTIVE;
    request.cancelledAt = null;
    request.cancelledBy = '';
    request.cancelledByName = '';
    request.cancelReason = '';
    request.cancelSource = '';
    request.updatedBy = actor.by;
    request.updatedByName = actor.byName;
    request.history.push({ ...actor, at: now, action: 'restored_by_staff', meta: { revision } });
    await request.save();
    return { action: 'restored', request, offer };
  });
}

module.exports = {
  revisionOf,
  validateQuantity,
  createSellerRequest,
  updateSellerRequest,
  cancelSellerRequest,
  cancelRequestByStaff,
  restoreRequestByStaff,
};
