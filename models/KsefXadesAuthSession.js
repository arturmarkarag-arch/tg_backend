'use strict';

const mongoose = require('mongoose');

const EncryptedSecretSchema = new mongoose.Schema({
  version: { type: Number, required: true, enum: [1] },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  ciphertext: { type: String, required: true },
}, { _id: false });

const KsefXadesAuthSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, trim: true, maxlength: 64 },
  credentialId: { type: String, required: true, trim: true, maxlength: 64 },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', required: true },
  environment: { type: String, required: true, enum: ['test', 'demo', 'prod'] },
  accessTokenEncrypted: { type: EncryptedSecretSchema, default: null, select: false },
  accessTokenValidUntil: { type: Date, default: null, select: false },
  refreshTokenEncrypted: { type: EncryptedSecretSchema, default: null, select: false },
  refreshTokenValidUntil: { type: Date, default: null, select: false },
  lastAuthAt: { type: Date, default: null },
  lastError: { type: String, default: '', trim: true, maxlength: 1000 },
}, { timestamps: true, optimisticConcurrency: true });

KsefXadesAuthSessionSchema.index({ sessionId: 1 }, { unique: true });
KsefXadesAuthSessionSchema.index({ credentialId: 1, legalEntityId: 1, environment: 1 }, { unique: true });

module.exports = mongoose.model('KsefXadesAuthSession', KsefXadesAuthSessionSchema);
