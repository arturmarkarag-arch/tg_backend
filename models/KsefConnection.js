'use strict';

const mongoose = require('mongoose');

const EncryptedSecretSchema = new mongoose.Schema({
  version: { type: Number, required: true, enum: [1] },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  ciphertext: { type: String, required: true },
}, { _id: false });

const KsefConnectionSchema = new mongoose.Schema({
  connectionId: { type: String, required: true, trim: true, maxlength: 64 },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', required: true },
  environment: { type: String, required: true, enum: ['test', 'demo', 'prod'] },
  enabled: { type: Boolean, default: true, index: true },
  authMethod: { type: String, default: 'token', enum: ['token'] },

  tokenEncrypted: { type: EncryptedSecretSchema, required: true, select: false },
  tokenFingerprint: { type: String, required: true, select: false },
  tokenHint: { type: String, required: true, trim: true, maxlength: 16 },

  accessTokenEncrypted: { type: EncryptedSecretSchema, default: null, select: false },
  accessTokenValidUntil: { type: Date, default: null, select: false },
  refreshTokenEncrypted: { type: EncryptedSecretSchema, default: null, select: false },
  refreshTokenValidUntil: { type: Date, default: null, select: false },

  lastAuthAt: { type: Date, default: null },
  lastConnectionCheckAt: { type: Date, default: null },
  lastConnectionError: { type: String, default: '', trim: true, maxlength: 1000 },
}, { timestamps: true, optimisticConcurrency: true });

KsefConnectionSchema.index({ connectionId: 1 }, { unique: true });
KsefConnectionSchema.index({ legalEntityId: 1, environment: 1 }, { unique: true });
KsefConnectionSchema.index({ enabled: 1, legalEntityId: 1 });

module.exports = mongoose.model('KsefConnection', KsefConnectionSchema);
