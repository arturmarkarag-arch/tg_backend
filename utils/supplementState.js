'use strict';

/**
 * Canonical V48.S3 supplement state vocabulary.
 *
 * This module is intentionally dependency-free so every transport/service/read
 * model can share the same semantics without importing Mongo models or inventing
 * local status predicates.
 */
const ITEM_STATUS = Object.freeze({
  OPEN: 'open',
  FROZEN: 'frozen',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

const ITEM_RELATION_STATUS = Object.freeze({
  ACTIVE: 'active',
  WITHDRAWN: 'withdrawn',
});

const REQUEST_STATUS = Object.freeze({
  ACTIVE: 'active',
  CANCELLED: 'cancelled',
});

const REQUEST_CANCEL_SOURCE = Object.freeze({
  SELLER: 'seller',
  STAFF: 'staff',
  SYSTEM: 'system',
});

const ACTIVE_ITEM_STATUSES = Object.freeze([ITEM_STATUS.OPEN, ITEM_STATUS.FROZEN]);
const TERMINAL_ITEM_STATUSES = Object.freeze([ITEM_STATUS.COMPLETED, ITEM_STATUS.CANCELLED]);

// ReceiptItem-facing lifecycle. This is the single read model used by the
// receiving gallery and route commands; UI must not infer availability from the
// route checkbox alone.
const RECEIPT_ITEM_SUPPLEMENT_STATE = Object.freeze({
  NONE: 'NONE',
  WAITING_RECEIPT: 'WAITING_RECEIPT',
  READY: 'READY',
  OPEN: 'OPEN',
  FROZEN: 'FROZEN',
  COMPLETED: 'COMPLETED',
});

function revisionOf(value) {
  const raw = typeof value === 'object' && value !== null ? value.revision : value;
  const parsed = Number(raw || 1);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function nextRevision(value) {
  const current = revisionOf(value);
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error('supplement_revision_exhausted');
  return current + 1;
}

function isRelationActive(offer) {
  return offer?.itemStatus !== ITEM_RELATION_STATUS.WITHDRAWN;
}

function isActiveItemRevision(offer) {
  return isRelationActive(offer) && ACTIVE_ITEM_STATUSES.includes(String(offer?.status || ''));
}

function isSellerEditable(offer) {
  return isRelationActive(offer) && offer?.status === ITEM_STATUS.OPEN;
}

function isPackable(offer) {
  return isRelationActive(offer) && offer?.status === ITEM_STATUS.FROZEN;
}

/**
 * Active OPEN/FROZEN work cannot be duplicated and COMPLETED history is final.
 * CANCELLED always releases the ReceiptItem for a clean revision; removing the
 * canonical supplement route is the separate command that prevents publication.
 */
function blocksGenericRepublish(offer) {
  if (!offer) return false;
  const status = String(offer.status || '');
  if (hasCompletedLifecycle(offer)) return true;
  if (status === ITEM_STATUS.CANCELLED) return false;
  if ([ITEM_STATUS.OPEN, ITEM_STATUS.FROZEN].includes(status)) return isRelationActive(offer);
  return isRelationActive(offer);
}

function hasCompletedLifecycle(offer) {
  if (!offer) return false;
  if (offer.completedAt || offer.status === ITEM_STATUS.COMPLETED) return true;
  return (Array.isArray(offer.revisionHistory) ? offer.revisionHistory : []).some((revision) => (
    Boolean(revision?.completedAt) || revision?.status === ITEM_STATUS.COMPLETED
  ));
}

/**
 * Canonical lifecycle projected onto a receiving item.
 *
 * COMPLETED history wins over the current withdrawn relation. Any cancellation
 * releases the item: it returns to READY when its route still permits supplement,
 * or NONE when staff explicitly removed that route.
 */
function deriveReceiptItemSupplementState({
  offers = [],
  routingSupplement = false,
  receiptCompleted = false,
} = {}) {
  const publications = (Array.isArray(offers) ? offers : []).filter(Boolean);
  if (publications.some(hasCompletedLifecycle)) {
    return RECEIPT_ITEM_SUPPLEMENT_STATE.COMPLETED;
  }

  const activeRelations = publications.filter(isRelationActive);
  if (activeRelations.some((offer) => offer.status === ITEM_STATUS.FROZEN)) {
    return RECEIPT_ITEM_SUPPLEMENT_STATE.FROZEN;
  }
  if (activeRelations.some((offer) => offer.status === ITEM_STATUS.OPEN)) {
    return RECEIPT_ITEM_SUPPLEMENT_STATE.OPEN;
  }
  if (!routingSupplement) return RECEIPT_ITEM_SUPPLEMENT_STATE.NONE;
  return receiptCompleted
    ? RECEIPT_ITEM_SUPPLEMENT_STATE.READY
    : RECEIPT_ITEM_SUPPLEMENT_STATE.WAITING_RECEIPT;
}

function isTerminalReceiptItemSupplementState(state) {
  return state === RECEIPT_ITEM_SUPPLEMENT_STATE.COMPLETED;
}

function findActiveReceiptItemSupplementOffer(offers = [], state = null) {
  const targetStatus = state === RECEIPT_ITEM_SUPPLEMENT_STATE.OPEN
    ? ITEM_STATUS.OPEN
    : state === RECEIPT_ITEM_SUPPLEMENT_STATE.FROZEN
      ? ITEM_STATUS.FROZEN
      : null;
  if (!targetStatus) return null;
  return (Array.isArray(offers) ? offers : [])
    .filter((offer) => isRelationActive(offer) && offer?.status === targetStatus)
    .sort((a, b) => new Date(b?.openedAt || 0).getTime() - new Date(a?.openedAt || 0).getTime())[0]
    || null;
}

function sellerMayRestoreRequest(request) {
  if (!request || request.status !== REQUEST_STATUS.CANCELLED) return false;
  if (request.cancelSource === REQUEST_CANCEL_SOURCE.SELLER) return true;
  // Compatibility for rows created before cancelSource existed. Only the old
  // canonical seller reason is restorable; unknown/administrative cancellations
  // fail closed.
  return !request.cancelSource && String(request.cancelReason || '') === 'seller_cancelled';
}

function requestBelongsToCurrentRevision(request, offer) {
  return Boolean(request && offer && revisionOf(request) === revisionOf(offer));
}

/** Derived container summary only; never business authority for seller/packing. */
function deriveContainerSummary(offers = []) {
  const rows = Array.isArray(offers) ? offers : [];
  const activeRelations = rows.filter(isRelationActive);
  if (activeRelations.some((offer) => offer.status === ITEM_STATUS.OPEN)) return ITEM_STATUS.OPEN;
  if (activeRelations.some((offer) => offer.status === ITEM_STATUS.FROZEN)) return ITEM_STATUS.FROZEN;
  if (rows.some((offer) => !isRelationActive(offer) || offer.status === ITEM_STATUS.CANCELLED)) return ITEM_STATUS.CANCELLED;
  return ITEM_STATUS.COMPLETED;
}

module.exports = {
  ITEM_STATUS,
  ITEM_RELATION_STATUS,
  REQUEST_STATUS,
  REQUEST_CANCEL_SOURCE,
  ACTIVE_ITEM_STATUSES,
  TERMINAL_ITEM_STATUSES,
  RECEIPT_ITEM_SUPPLEMENT_STATE,
  revisionOf,
  nextRevision,
  isRelationActive,
  isActiveItemRevision,
  isSellerEditable,
  isPackable,
  blocksGenericRepublish,
  hasCompletedLifecycle,
  deriveReceiptItemSupplementState,
  isTerminalReceiptItemSupplementState,
  findActiveReceiptItemSupplementOffer,
  sellerMayRestoreRequest,
  requestBelongsToCurrentRevision,
  deriveContainerSummary,
};
