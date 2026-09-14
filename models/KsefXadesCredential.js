'use strict';

const mongoose = require('mongoose');

const EncryptedSecretSchema = new mongoose.Schema({
  version: { type: Number, required: true, enum: [1] },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  ciphertext: { type: String, required: true },
}, { _id: false });

const KsefXadesCredentialSchema = new mongoose.Schema({
  credentialId: { type: String, required: true, trim: true, maxlength: 64 },
  environment: { type: String, required: true, enum: ['test', 'demo', 'prod'] },
  credentialName: { type: String, default: '', trim: true, maxlength: 200 },
  source: { type: String, required: true, enum: ['manual_import', 'ksef_enrollment'], default: 'manual_import' },
  certificateType: { type: String, required: true, enum: ['External', 'Authentication'], default: 'External' },
  subjectIdentifierType: { type: String, required: true, enum: ['certificateSubject', 'certificateFingerprint'], default: 'certificateSubject' },
  verifyCertificateChain: { type: Boolean, default: true },
  enabled: { type: Boolean, default: true, index: true },

  certificateBase64: { type: String, required: true, select: false },
  certificateSha256Hex: { type: String, required: true, trim: true, maxlength: 128 },
  certificateSerialNumber: { type: String, required: true, trim: true, maxlength: 128 },
  privateKeyEncrypted: { type: EncryptedSecretSchema, required: true, select: false },
  privateKeyFingerprint: { type: String, required: true, select: false },
  keyAlgorithm: { type: String, required: true, enum: ['rsa', 'ec'] },
  keyDetails: { type: mongoose.Schema.Types.Mixed, default: null },
  subject: { type: String, default: '', trim: true, maxlength: 2000 },
  issuer: { type: String, default: '', trim: true, maxlength: 2000 },
  validFrom: { type: Date, required: true },
  validTo: { type: Date, required: true },

  lastAuthAt: { type: Date, default: null },
  lastConnectionCheckAt: { type: Date, default: null },
  lastConnectionError: { type: String, default: '', trim: true, maxlength: 1000 },
  revokedAt: { type: Date, default: null },
  importedAt: { type: Date, default: null },
}, { timestamps: true, optimisticConcurrency: true });

KsefXadesCredentialSchema.index({ credentialId: 1 }, { unique: true });
KsefXadesCredentialSchema.index({ environment: 1, certificateSerialNumber: 1 }, { unique: true });
KsefXadesCredentialSchema.index({ environment: 1, enabled: 1, validTo: 1 });

module.exports = mongoose.model('KsefXadesCredential', KsefXadesCredentialSchema);
