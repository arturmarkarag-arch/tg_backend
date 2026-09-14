'use strict';

const mongoose = require('mongoose');

const EncryptedSecretSchema = new mongoose.Schema({
  version: { type: Number, required: true, enum: [1] },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  ciphertext: { type: String, required: true },
}, { _id: false });

const KsefCertificateEnrollmentSchema = new mongoose.Schema({
  enrollmentId: { type: String, required: true, trim: true, maxlength: 64 },
  xadesCredentialId: { type: String, required: true, trim: true, maxlength: 64 },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', required: true },
  environment: { type: String, required: true, enum: ['test', 'demo', 'prod'] },
  certificateName: { type: String, required: true, trim: true, maxlength: 100 },
  certificateType: { type: String, required: true, enum: ['Authentication', 'Offline'] },
  keyAlgorithm: { type: String, required: true, enum: ['ec', 'rsa'], default: 'ec' },
  validFrom: { type: Date, default: null },

  state: {
    type: String,
    required: true,
    enum: ['prepared', 'submitted', 'processing', 'issued', 'failed', 'ambiguous_submit', 'manual_review'],
    default: 'prepared',
    index: true,
  },
  enrollmentDataHash: { type: String, required: true, trim: true, maxlength: 128 },
  csrSha256Hex: { type: String, required: true, trim: true, maxlength: 128 },
  csrBase64: { type: String, required: true, select: false },
  privateKeyEncrypted: { type: EncryptedSecretSchema, default: null, select: false },
  privateKeyFingerprint: { type: String, required: true, select: false },

  referenceNumber: { type: String, default: '', trim: true, maxlength: 200 },
  requestDate: { type: Date, default: null },
  providerStatusCode: { type: Number, default: null },
  providerStatusDescription: { type: String, default: '', trim: true, maxlength: 1000 },
  certificateSerialNumber: { type: String, default: '', trim: true, maxlength: 128 },
  issuedCredentialId: { type: String, default: '', trim: true, maxlength: 64 },
  issuedOfflineCertificateId: { type: String, default: '', trim: true, maxlength: 64 },

  lastCheckedAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: '', trim: true, maxlength: 100 },
  lastErrorMessage: { type: String, default: '', trim: true, maxlength: 1000 },
}, { timestamps: true, optimisticConcurrency: true });

KsefCertificateEnrollmentSchema.index({ enrollmentId: 1 }, { unique: true });
KsefCertificateEnrollmentSchema.index({ environment: 1, referenceNumber: 1 }, { unique: true, sparse: true });
KsefCertificateEnrollmentSchema.index({ xadesCredentialId: 1, createdAt: -1 });
KsefCertificateEnrollmentSchema.index({ state: 1, updatedAt: 1 });

module.exports = mongoose.model('KsefCertificateEnrollment', KsefCertificateEnrollmentSchema);
