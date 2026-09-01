'use strict';

const mongoose = require('mongoose');

const TelegramMessageCleanupSchema = new mongoose.Schema({
  dedupeKey: { type: String, required: true, unique: true },
  sourceType: { type: String, enum: ['receipt_new_product'], required: true },
  sourceId: { type: String, required: true },
  receiptId: { type: String, default: '' },
  publicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramPublication', default: null },
  bindingId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramPublicationBinding', default: null },
  generation: { type: Number, default: null },
  kind: { type: String, enum: ['exact_message', 'ambiguous_create'], default: 'exact_message' },
  chatId: { type: String, required: true },
  messageId: { type: Number, default: null },
  captionSnapshot: { type: String, default: '' },
  payloadHash: { type: String, default: '' },
  reason: { type: String, enum: ['receipt_item_deleted', 'receipt_item_unconfirmed', 'duplicate_resolution'], required: true },
  status: {
    type: String,
    enum: ['pending', 'sending', 'retry_wait', 'done', 'manual_required', 'failed'],
    default: 'pending',
  },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  nextAttemptAt: { type: Date, default: Date.now },
  leaseUntil: { type: Date, default: null },
  lastAttemptAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  manuallyResolvedAt: { type: Date, default: null },
  manuallyResolvedBy: { type: String, default: '' },
  resolutionNote: { type: String, default: '' },
  lastError: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { timestamps: true });

TelegramMessageCleanupSchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
TelegramMessageCleanupSchema.index({ publicationId: 1, status: 1, createdAt: 1 });
TelegramMessageCleanupSchema.index({ bindingId: 1, status: 1 });

module.exports = mongoose.model('TelegramMessageCleanup', TelegramMessageCleanupSchema);
