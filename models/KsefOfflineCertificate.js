'use strict';

const mongoose = require('mongoose');

const EncryptedSecretSchema = new mongoose.Schema({
  version: { type: Number, required: true, enum: [1] },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  ciphertext: { type: String, required: true },
}, { _id: false });

const KsefOfflineCertificateSchema = new mongoose.Schema({
  certificateId: { type: String, required: true, trim: true, maxlength: 64 },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', required: true },
  environment: { type: String, required: true, enum: ['test', 'demo', 'prod'] },
  certificateSerialNumber: { type: String, required: true, trim: true, maxlength: 128 },
  certificateName: { type: String, default: '', trim: true, maxlength: 200 },
  certificateType: { type: String, required: true, enum: ['Offline'], default: 'Offline' },
  source: { type: String, required: true, enum: ['manual_import', 'ksef_enrollment'], default: 'manual_import' },
  enabled: { type: Boolean, default: true, index: true },
  isDefault: { type: Boolean, default: false },

  certificateBase64: { type: String, required: true, select: false },
  certificateSha256Hex: { type: String, required: true, trim: true, maxlength: 128 },
  privateKeyEncrypted: { type: EncryptedSecretSchema, required: true, select: false },
  privateKeyFingerprint: { type: String, required: true, select: false },

  keyAlgorithm: { type: String, required: true, enum: ['rsa', 'ec'] },
  keyDetails: { type: mongoose.Schema.Types.Mixed, default: null },
  keyUsage: { type: mongoose.Schema.Types.Mixed, default: null },
  subject: { type: String, default: '', trim: true, maxlength: 2000 },
  issuer: { type: String, default: '', trim: true, maxlength: 2000 },
  validFrom: { type: Date, required: true },
  validTo: { type: Date, required: true },

  importedAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
}, { timestamps: true, optimisticConcurrency: true });

KsefOfflineCertificateSchema.index({ certificateId: 1 }, { unique: true });
KsefOfflineCertificateSchema.index({ environment: 1, certificateSerialNumber: 1, legalEntityId: 1 }, { unique: true });
KsefOfflineCertificateSchema.index({ legalEntityId: 1, environment: 1, enabled: 1, validTo: 1 });
KsefOfflineCertificateSchema.index(
  { legalEntityId: 1, environment: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);

module.exports = mongoose.model('KsefOfflineCertificate', KsefOfflineCertificateSchema);
