'use strict';

const mongoose = require('mongoose');

// Актуальна бізнес-логіка: docs/supplement/readme.md
const SupplementOfferSchema = new mongoose.Schema(
  {
    receiptId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt', required: true },
    receiptItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReceiptItem', required: true },
    productId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    deliveryGroupId: { type: String, required: true },

    openedAt: { type: Date, default: Date.now },
    // Лише сумісність зі старими документами. Нова логіка закривається вручну.
    closesAt: { type: Date, default: null },

    status: { type: String, enum: ['open', 'frozen', 'completed'], default: 'open' },
    frozenAt:     { type: Date, default: null },
    frozenBy:     { type: String, default: '' },
    frozenByName: { type: String, default: '' },
    completedAt:  { type: Date, default: null },

    lockedBy: { type: String, default: null },
    lockedAt: { type: Date, default: null },
    completedBy:     { type: String, default: null },
    completedByName: { type: String, default: '' },

    notifiedTypes: { type: [String], default: [] },
    lastReminderAt: { type: Date, default: null },
  },
  { timestamps: true },
);

SupplementOfferSchema.statics.ACTIVE_STATUSES = ['open', 'frozen'];

// Один рядок накладної створює максимум одну пропозицію для вибраної групи.
SupplementOfferSchema.index({ receiptItemId: 1, deliveryGroupId: 1 }, { unique: true });

// Окремі накладні можуть одночасно відкривати той самий товар тій самій групі.
SupplementOfferSchema.index({ deliveryGroupId: 1, status: 1 });
SupplementOfferSchema.index({ status: 1, lastReminderAt: 1 });

module.exports = mongoose.model('SupplementOffer', SupplementOfferSchema);
