'use strict';

const mongoose = require('mongoose');

const SupplementSourceSnapshotSchema = new mongoose.Schema({
  title: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  originalImageUrl: { type: String, default: '' },
  price: { type: Number, default: 0 },
  quantityPerPackage: { type: Number, default: 0 },
  aiDescription: { type: String, default: '' },
}, { _id: false });

// Compatibility child entity. In V48.S2 a Wave owns lifecycle for new rows.
// Legacy rows without waveId continue using their own status fields.
const SupplementOfferSchema = new mongoose.Schema(
  {
    waveId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplementWave', default: null },
    orderingSessionId: { type: String, default: null },

    receiptId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt', required: true },
    receiptItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReceiptItem', required: true },
    // V48.S2: standalone supplement-only items do not create a fake warehouse Product.
    productId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    deliveryGroupId: { type: String, required: true },
    sourceSnapshot: { type: SupplementSourceSnapshotSchema, default: () => ({}) },

    // `active` means this Wave item is still part of work. `withdrawn` is a
    // compensating routing correction; history is preserved instead of deleted.
    itemStatus: { type: String, enum: ['active', 'withdrawn'], default: 'active' },
    withdrawnAt: { type: Date, default: null },
    withdrawnBy: { type: String, default: '' },
    withdrawnByName: { type: String, default: '' },
    withdrawReason: { type: String, default: '' },

    openedAt: { type: Date, default: Date.now },
    // Legacy only. New Wave lifecycle has no browser/deadline-driven close.
    closesAt: { type: Date, default: null },

    // Legacy lifecycle mirror. New Wave rows derive effective status from Wave.
    status: { type: String, enum: ['open', 'frozen', 'completed', 'cancelled'], default: 'open' },
    frozenAt:     { type: Date, default: null },
    frozenBy:     { type: String, default: '' },
    frozenByName: { type: String, default: '' },
    completedAt:  { type: Date, default: null },

    lockedBy: { type: String, default: null },
    lockedAt: { type: Date, default: null },
    completedBy:     { type: String, default: null },
    completedByName: { type: String, default: '' },

    // Legacy per-item notification idempotency. New rows use Wave.notifiedTypes.
    notifiedTypes: { type: [String], default: [] },
    lastReminderAt: { type: Date, default: null },
  },
  { timestamps: true },
);

SupplementOfferSchema.statics.ACTIVE_STATUSES = ['open', 'frozen'];

// Preserve the existing production uniqueness contract; no destructive index migration.
SupplementOfferSchema.index({ receiptItemId: 1, deliveryGroupId: 1 }, { unique: true });
SupplementOfferSchema.index({ waveId: 1, itemStatus: 1 });
SupplementOfferSchema.index({ orderingSessionId: 1, deliveryGroupId: 1, itemStatus: 1 });
SupplementOfferSchema.index({ deliveryGroupId: 1, status: 1 });
SupplementOfferSchema.index({ status: 1, lastReminderAt: 1 });

module.exports = mongoose.model('SupplementOffer', SupplementOfferSchema);
