'use strict';

const mongoose = require('mongoose');

const ArtifactSchema = new mongoose.Schema({
  format: { type: String, required: true, default: 'xml' },
  mediaType: { type: String, required: true, default: 'application/xml' },
  content: { type: String, required: true },
  sha256Hex: { type: String, required: true },
  hashBase64: { type: String, required: true },
  size: { type: Number, required: true, min: 1 },
}, { _id: false });

const ErrorSchema = new mongoose.Schema({
  code: { type: String, default: '' },
  message: { type: String, default: '' },
  httpStatus: { type: Number, default: null },
  providerCode: { type: String, default: '' },
  details: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const UpoSchema = new mongoose.Schema({
  contentBase64: { type: String, required: true, select: false },
  sha256Hex: { type: String, required: true },
  hashBase64: { type: String, required: true },
  providerHashBase64: { type: String, required: true },
  size: { type: Number, required: true },
  receivedAt: { type: Date, required: true },
}, { _id: false });

const KsefTechnicalCorrectionSchema = new mongoose.Schema({
  originalSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'FiscalSubmission', required: true, immutable: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, immutable: true },
  snapshotId: { type: mongoose.Schema.Types.ObjectId, ref: 'InvoiceSnapshot', required: true, immutable: true },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', required: true, immutable: true },
  connectionId: { type: String, required: true, trim: true, maxlength: 64 },
  environment: { type: String, required: true, trim: true, maxlength: 32 },
  state: {
    type: String,
    enum: ['prepared', 'submitted', 'processing', 'accepted', 'rejected', 'error', 'manual_review'],
    default: 'prepared',
    required: true,
  },
  originalHashBase64: { type: String, required: true, immutable: true },
  originalSha256Hex: { type: String, required: true, immutable: true },
  correctedArtifact: { type: ArtifactSchema, required: true, immutable: true },
  providerData: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  receipt: { type: UpoSchema, default: null },
  submittedAt: { type: Date, default: null },
  acceptedAt: { type: Date, default: null },
  rejectedAt: { type: Date, default: null },
  lastCheckedAt: { type: Date, default: null },
  lastError: { type: ErrorSchema, default: null },
}, { timestamps: true, optimisticConcurrency: true });

KsefTechnicalCorrectionSchema.index({ originalSubmissionId: 1 }, { unique: true });
KsefTechnicalCorrectionSchema.index({ environment: 1, state: 1, updatedAt: 1 });
KsefTechnicalCorrectionSchema.index(
  { environment: 1, 'providerData.invoiceReferenceNumber': 1 },
  { unique: true, partialFilterExpression: { 'providerData.invoiceReferenceNumber': { $type: 'string' } } },
);

module.exports = mongoose.model('KsefTechnicalCorrection', KsefTechnicalCorrectionSchema);
