'use strict';

const mongoose = require('mongoose');
const { REQUEST_STATUS, REQUEST_CANCEL_SOURCE } = require('../utils/supplementState');

const SupplementRequestHistorySchema = new mongoose.Schema(
  {
    at:     { type: Date, default: Date.now },
    by:     { type: String, default: '' },
    byName: { type: String, default: '' },
    byRole: { type: String, default: '' },
    action: { type: String, required: true },
    meta:   { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const SupplementRequestSchema = new mongoose.Schema(
  {
    waveId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplementWave', default: null },
    orderingSessionId: { type: String, default: null },
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplementOffer', required: true },
    // Exact item-publication generation. Old S2 rows are migrated to revision 1.
    revision: { type: Number, required: true, default: 1, min: 1 },
    shopId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    shopName: { type: String, default: '' },
    deliveryGroupId: { type: String, default: '' },

    quantity: { type: Number, required: true, min: 1, max: 6 },

    // Seller cancellation/correction is historical, not destructive, for V48.S2 rows.
    status: { type: String, enum: Object.values(REQUEST_STATUS), default: REQUEST_STATUS.ACTIVE },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: '' },
    cancelledByName: { type: String, default: '' },
    cancelReason: { type: String, default: '' },
    // Why this request is cancelled. Seller-cancelled rows may be restored while
    // the item is OPEN; staff/system cancellations are authoritative and fail closed.
    cancelSource: { type: String, enum: ['', ...Object.values(REQUEST_CANCEL_SOURCE)], default: '' },

    // Packing begins only after the owning item revision is FROZEN; Wave status is derived summary only.
    packed:       { type: Boolean, default: false },
    packedBy:     { type: String, default: '' },
    packedByName: { type: String, default: '' },
    packedAt:     { type: Date, default: null },

    createdBy:     { type: String, default: '' },
    createdByName: { type: String, default: '' },
    updatedBy:     { type: String, default: '' },
    updatedByName: { type: String, default: '' },

    history: { type: [SupplementRequestHistorySchema], default: [] },
  },
  { timestamps: true },
);

SupplementRequestSchema.index({ offerId: 1, revision: 1, shopId: 1 }, { unique: true });
SupplementRequestSchema.index({ waveId: 1, revision: 1, status: 1, shopId: 1 });
SupplementRequestSchema.index({ orderingSessionId: 1, packed: 1 });
SupplementRequestSchema.index({ deliveryGroupId: 1, shopId: 1 });
SupplementRequestSchema.index({ shopId: 1, createdAt: -1 });
SupplementRequestSchema.index({ createdBy: 1, createdAt: -1 });

module.exports = mongoose.model('SupplementRequest', SupplementRequestSchema);
