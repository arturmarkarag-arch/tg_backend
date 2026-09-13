'use strict';

const mongoose = require('mongoose');

const ErrorSchema = new mongoose.Schema({
  code: { type: String, default: '' },
  message: { type: String, default: '' },
  httpStatus: { type: Number, default: null },
  providerCode: { type: String, default: '' },
  details: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const ArtifactSchema = new mongoose.Schema({
  format: { type: String, required: true, trim: true, maxlength: 32 },
  mediaType: { type: String, required: true, trim: true, maxlength: 128 },
  content: { type: String, required: true },
  sha256Hex: { type: String, required: true, trim: true, maxlength: 128 },
  hashBase64: { type: String, default: '', trim: true, maxlength: 128 },
  size: { type: Number, required: true, min: 1 },
}, { _id: false });

const FiscalSubmissionSchema = new mongoose.Schema({
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
  snapshotId: { type: mongoose.Schema.Types.ObjectId, ref: 'InvoiceSnapshot', required: true },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', required: true },

  // Provider-neutral routing identity. KSeF-specific state belongs in providerData.
  provider: { type: String, required: true, trim: true, maxlength: 64 },
  connectionId: { type: String, required: true, trim: true, maxlength: 64 },
  environment: { type: String, required: true, trim: true, maxlength: 32 },
  mode: { type: String, required: true, trim: true, maxlength: 32 },
  state: {
    type: String,
    required: true,
    enum: ['prepared', 'submitted', 'processing', 'accepted', 'rejected', 'error'],
    default: 'prepared',
  },

  documentSchema: { type: mongoose.Schema.Types.Mixed, default: null },
  artifact: { type: ArtifactSchema, required: true },
  providerData: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

  submittedAt: { type: Date, default: null },
  acceptedAt: { type: Date, default: null },
  rejectedAt: { type: Date, default: null },
  lastCheckedAt: { type: Date, default: null },
  lastError: { type: ErrorSchema, default: null },
}, { timestamps: true, optimisticConcurrency: true });

FiscalSubmissionSchema.index({ snapshotId: 1, provider: 1, environment: 1 }, { unique: true });
FiscalSubmissionSchema.index({ invoiceId: 1, provider: 1, createdAt: -1 });
FiscalSubmissionSchema.index({ provider: 1, environment: 1, state: 1, updatedAt: 1 });

module.exports = mongoose.model('FiscalSubmission', FiscalSubmissionSchema);
