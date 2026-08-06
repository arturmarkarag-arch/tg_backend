'use strict';

const mongoose = require('mongoose');

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

// Актуальна бізнес-логіка: docs/supplement/readme.md
const SupplementRequestSchema = new mongoose.Schema(
  {
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplementOffer', required: true },
    shopId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    shopName: { type: String, default: '' },
    deliveryGroupId: { type: String, default: '' },

    quantity: { type: Number, required: true, min: 1, max: 6 },

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

SupplementRequestSchema.index({ offerId: 1, shopId: 1 }, { unique: true });
SupplementRequestSchema.index({ deliveryGroupId: 1, shopId: 1 });
SupplementRequestSchema.index({ shopId: 1, createdAt: -1 });
SupplementRequestSchema.index({ createdBy: 1, createdAt: -1 });

module.exports = mongoose.model('SupplementRequest', SupplementRequestSchema);
