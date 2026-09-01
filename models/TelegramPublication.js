'use strict';

const mongoose = require('mongoose');

const TelegramPublicationSchema = new mongoose.Schema({
  sourceType: { type: String, enum: ['receipt_new_product'], required: true },
  sourceId: { type: String, required: true },
  receiptId: { type: String, default: '' },
  destinationKey: { type: String, default: 'new_products' },

  status: {
    type: String,
    enum: ['not_sent', 'queued', 'sending', 'retry_wait', 'sent', 'failed', 'unknown', 'missing', 'retired'],
    default: 'not_sent',
  },
  sourceState: { type: String, enum: ['draft', 'confirmed', 'deleted'], default: 'draft' },
  targetChatId: { type: String, default: '' },
  targetConfigRevision: { type: Number, default: 0, min: 0 },
  currentBindingId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramPublicationBinding', default: null },
  generation: { type: Number, default: 0, min: 0 },
  sendingOperation: { type: String, enum: ['', 'create', 'update'], default: '' },
  sendingBindingId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramPublicationBinding', default: null },

  desiredHash: { type: String, default: '' },
  desiredSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  desiredCaption: { type: String, default: '' },
  appliedHash: { type: String, default: '' },
  appliedSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  appliedCaption: { type: String, default: '' },

  requestedAt: { type: Date, default: null },
  requestedBy: { type: String, default: '' },
  sentAt: { type: Date, default: null },
  editedAt: { type: Date, default: null },
  missingAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: null },
  leaseUntil: { type: Date, default: null },
  lastAttemptAt: { type: Date, default: null },
  lastError: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

  lastDecision: { type: String, enum: ['', 'publish', 'skip'], default: '' },
  lastDecisionHash: { type: String, default: '' },
  lastDecisionAt: { type: Date, default: null },
  lastDecisionBy: { type: String, default: '' },

  possibleDuplicate: { type: Boolean, default: false },
  unresolvedBindingCount: { type: Number, default: 0, min: 0 },
  ambiguousBindingCount: { type: Number, default: 0, min: 0 },
  sourceRetiredAt: { type: Date, default: null },
  legacyMigratedAt: { type: Date, default: null },
}, { timestamps: true });

TelegramPublicationSchema.index({ sourceType: 1, sourceId: 1 }, { unique: true });
TelegramPublicationSchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
TelegramPublicationSchema.index({ destinationKey: 1, targetChatId: 1, status: 1 });

module.exports = mongoose.model('TelegramPublication', TelegramPublicationSchema);
