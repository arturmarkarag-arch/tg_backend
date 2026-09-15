'use strict';

const mongoose = require('mongoose');

const InvoiceSourceAutomationStateSchema = new mongoose.Schema({
  provider: { type: String, required: true, trim: true, lowercase: true, maxlength: 60 },
  accountId: { type: String, required: true, trim: true, maxlength: 120 },
  orderId: { type: String, required: true, trim: true, maxlength: 180 },
  sourceAdapterId: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
  revision: { type: String, default: '', trim: true, maxlength: 128 },
  status: { type: String, enum: ['unbound', 'blocked', 'draft_created', 'finalized_source_changed', 'error'], required: true },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', default: null },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
  blockers: { type: [String], default: [] },
  lastErrorCode: { type: String, default: '', trim: true, maxlength: 160 },
  observedAt: { type: Date, default: Date.now },
  attemptedAt: { type: Date, default: Date.now },
  nextRetryAt: { type: Date, default: null },
}, { timestamps: true });

InvoiceSourceAutomationStateSchema.index({ provider: 1, accountId: 1, orderId: 1 }, { unique: true });
InvoiceSourceAutomationStateSchema.index({ status: 1, nextRetryAt: 1, updatedAt: -1 });
InvoiceSourceAutomationStateSchema.index({ invoiceId: 1 }, { sparse: true });

module.exports = mongoose.model('InvoiceSourceAutomationState', InvoiceSourceAutomationStateSchema);
