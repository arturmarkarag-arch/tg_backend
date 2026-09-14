'use strict';

const mongoose = require('mongoose');

const EncryptedSecretSchema = new mongoose.Schema({
  version: { type: Number, required: true, enum: [1] },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  ciphertext: { type: String, required: true },
}, { _id: false });

const ErrorSchema = new mongoose.Schema({
  code: { type: String, default: '' },
  message: { type: String, default: '' },
  httpStatus: { type: Number, default: null },
  providerCode: { type: String, default: '' },
  details: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const PartSchema = new mongoose.Schema({
  partName: { type: String, required: true, trim: true, maxlength: 256 },
  partSize: { type: Number, required: true, min: 0 },
  partHash: { type: String, required: true, trim: true, maxlength: 64 },
  encryptedPartSize: { type: Number, required: true, min: 1 },
  encryptedPartHash: { type: String, required: true, trim: true, maxlength: 64 },
  expirationDate: { type: Date, default: null },
}, { _id: false });

const KsefInboundExportSchema = new mongoose.Schema({
  exportId: { type: String, required: true, trim: true, maxlength: 64 },
  exportKey: { type: String, required: true, trim: true, maxlength: 64 },
  syncId: { type: String, required: true, trim: true, maxlength: 64 },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', required: true },
  environment: { type: String, required: true, enum: ['test', 'demo', 'prod'] },
  subjectType: { type: String, required: true, enum: ['Subject2'], default: 'Subject2' },
  reason: { type: String, enum: ['metadata_truncated', 'manual'], default: 'metadata_truncated' },
  fromPermanentStorageDate: { type: Date, required: true },
  toPermanentStorageDate: { type: Date, required: true },
  compressionType: { type: String, required: true, enum: ['TarGz'], default: 'TarGz' },

  state: {
    type: String,
    required: true,
    enum: ['prepared', 'running', 'processing', 'retry_wait', 'complete', 'ambiguous_submit', 'manual_review'],
    default: 'prepared',
    index: true,
  },
  referenceNumber: { type: String, default: '', trim: true, maxlength: 64 },
  symmetricKeyEncrypted: { type: EncryptedSecretSchema, required: true, select: false },
  initializationVectorEncrypted: { type: EncryptedSecretSchema, required: true, select: false },
  publicKeyId: { type: String, default: '', trim: true, maxlength: 128 },

  providerStatusCode: { type: Number, default: null },
  providerStatusDescription: { type: String, default: '', trim: true, maxlength: 1000 },
  completedDate: { type: Date, default: null },
  packageExpirationDate: { type: Date, default: null },
  package: {
    invoiceCount: { type: Number, default: 0, min: 0 },
    size: { type: Number, default: 0, min: 0 },
    isTruncated: { type: Boolean, default: false },
    lastPermanentStorageDate: { type: Date, default: null },
    permanentStorageHwmDate: { type: Date, default: null },
    parts: { type: [PartSchema], default: [] },
  },
  stats: {
    metadataEntries: { type: Number, default: 0, min: 0 },
    xmlEntries: { type: Number, default: 0, min: 0 },
    created: { type: Number, default: 0, min: 0 },
    updated: { type: Number, default: 0, min: 0 },
    stored: { type: Number, default: 0, min: 0 },
    alreadyStored: { type: Number, default: 0, min: 0 },
    deferred: { type: Number, default: 0, min: 0 },
    conflicts: { type: Number, default: 0, min: 0 },
  },

  attempts: { type: Number, default: 0, min: 0 },
  nextAttemptAt: { type: Date, default: null },
  leaseUntil: { type: Date, default: null },
  lastAttemptAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastError: { type: ErrorSchema, default: null },
}, { timestamps: true, optimisticConcurrency: true });

KsefInboundExportSchema.index({ exportId: 1 }, { unique: true });
KsefInboundExportSchema.index({ exportKey: 1 }, { unique: true });
KsefInboundExportSchema.index({ environment: 1, referenceNumber: 1 }, { unique: true, sparse: true });
KsefInboundExportSchema.index({ syncId: 1, createdAt: -1 });
KsefInboundExportSchema.index({ state: 1, nextAttemptAt: 1, leaseUntil: 1 });

module.exports = mongoose.model('KsefInboundExport', KsefInboundExportSchema);
