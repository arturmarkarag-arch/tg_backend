'use strict';

const mongoose = require('mongoose');
const { ITEM_STATUS, ITEM_RELATION_STATUS, ACTIVE_ITEM_STATUSES, TERMINAL_ITEM_STATUSES } = require('../utils/supplementState');

const SupplementSourceSnapshotSchema = new mongoose.Schema({
  title: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  originalImageUrl: { type: String, default: '' },
  price: { type: Number, default: 0 },
  quantityPerPackage: { type: Number, default: 0 },
  aiDescription: { type: String, default: '' },
}, { _id: false });

const SupplementOfferRevisionSchema = new mongoose.Schema({
  revision: { type: Number, required: true },
  status: { type: String, enum: Object.values(ITEM_STATUS), required: true },
  sourceSnapshot: { type: SupplementSourceSnapshotSchema, default: () => ({}) },
  openedAt: { type: Date, default: null },
  openedBy: { type: String, default: '' },
  openedByName: { type: String, default: '' },
  frozenAt: { type: Date, default: null },
  frozenBy: { type: String, default: '' },
  frozenByName: { type: String, default: '' },
  completedAt: { type: Date, default: null },
  completedBy: { type: String, default: '' },
  completedByName: { type: String, default: '' },
  cancelledAt: { type: Date, default: null },
  cancelledBy: { type: String, default: '' },
  cancelledByName: { type: String, default: '' },
  cancelReason: { type: String, default: '' },
  archivedAt: { type: Date, default: Date.now },
}, { _id: false });

/**
 * One stable item slot inside a group+session SupplementWave container.
 * `revision` identifies the CURRENT publication cycle for this item. Re-running
 * a cancelled item increments revision and starts with clean current requests;
 * prior request rows remain immutable history under their old revision.
 */
const SupplementOfferSchema = new mongoose.Schema(
  {
    waveId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplementWave', default: null },
    orderingSessionId: { type: String, default: null },

    receiptId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt', required: true },
    receiptItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReceiptItem', required: true },
    productId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    deliveryGroupId: { type: String, required: true },
    sourceSnapshot: { type: SupplementSourceSnapshotSchema, default: () => ({}) },

    // Current publication generation. Existing V48.S2 rows migrate to revision 1.
    revision: { type: Number, default: 1, min: 1 },
    revisionHistory: { type: [SupplementOfferRevisionSchema], default: [] },

    // `withdrawn` means the canonical Receipt route currently no longer exposes
    // this item as supplement. Administrative cancellation alone leaves `active`
    // so the same item may be published again without changing Receipt routing.
    itemStatus: { type: String, enum: Object.values(ITEM_RELATION_STATUS), default: ITEM_RELATION_STATUS.ACTIVE },
    withdrawnAt: { type: Date, default: null },
    withdrawnBy: { type: String, default: '' },
    withdrawnByName: { type: String, default: '' },
    withdrawReason: { type: String, default: '' },

    openedAt: { type: Date, default: Date.now },
    openedBy: { type: String, default: '' },
    openedByName: { type: String, default: '' },
    closesAt: { type: Date, default: null }, // legacy only

    // V48.S3 authority: current item revision lifecycle.
    status: { type: String, enum: Object.values(ITEM_STATUS), default: 'open' },
    frozenAt:     { type: Date, default: null },
    frozenBy:     { type: String, default: '' },
    frozenByName: { type: String, default: '' },
    completedAt:  { type: Date, default: null },

    lockedBy: { type: String, default: null },
    lockedAt: { type: Date, default: null },
    completedBy:     { type: String, default: null },
    completedByName: { type: String, default: '' },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: '' },
    cancelledByName: { type: String, default: '' },
    cancelReason: { type: String, default: '' },

    // Legacy per-item notification fields remain readable.
    notifiedTypes: { type: [String], default: [] },
    lastReminderAt: { type: Date, default: null },
  },
  { timestamps: true },
);

SupplementOfferSchema.statics.ACTIVE_STATUSES = [...ACTIVE_ITEM_STATUSES];
SupplementOfferSchema.statics.TERMINAL_STATUSES = [...TERMINAL_ITEM_STATUSES];

// Modern identity: one stable ReceiptItem slot in one exact group+session container.
SupplementOfferSchema.index(
  { waveId: 1, receiptItemId: 1 },
  { unique: true, partialFilterExpression: { waveId: { $type: 'objectId' } } },
);
// Legacy waveId=null rows keep their original group-scoped uniqueness.
SupplementOfferSchema.index(
  { receiptItemId: 1, deliveryGroupId: 1 },
  { unique: true, partialFilterExpression: { waveId: null } },
);
SupplementOfferSchema.index({ waveId: 1, itemStatus: 1, status: 1 });
SupplementOfferSchema.index({ orderingSessionId: 1, deliveryGroupId: 1, itemStatus: 1, status: 1 });
SupplementOfferSchema.index({ deliveryGroupId: 1, status: 1 });
SupplementOfferSchema.index({ status: 1, lastReminderAt: 1 });

module.exports = mongoose.model('SupplementOffer', SupplementOfferSchema);
