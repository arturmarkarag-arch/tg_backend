'use strict';

const mongoose = require('mongoose');

const QueueSettingsSchema = new mongoose.Schema({
  intakeStatusId: { type: Number, required: true, min: 1 },
  sentStatusId: { type: Number, required: true, min: 1 },
  cancelledStatusId: { type: Number, required: true, min: 1 },
  revision: { type: String, required: true, trim: true, maxlength: 64 },
}, { _id: false });

const EncryptedTokenSchema = new mongoose.Schema({
  version: { type: Number, required: true, enum: [1] },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  ciphertext: { type: String, required: true },
}, { _id: false });

const BaseLinkerAccountSchema = new mongoose.Schema({
  // Greenfield invariant: every BaseLinker connection receives OUR durable UUID.
  // No API response, display name or token is used as the account identity.
  accountId: { type: String, required: true, trim: true, maxlength: 64 },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  color: { type: String, default: '', trim: true, maxlength: 32 },
  enabled: { type: Boolean, default: true, index: true },

  // Tokens are server-only and always encrypted at rest.
  tokenEncrypted: { type: EncryptedTokenSchema, required: true },
  tokenFingerprint: { type: String, required: true, select: false },
  tokenHint: { type: String, required: true, trim: true, maxlength: 16 },

  queue: { type: QueueSettingsSchema, required: true },

  // API-derived metadata is a cache/snapshot for labels, filters and validation.
  // Operational truth still comes from BaseLinker API calls with this account token.
  metadataSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  metadataFetchedAt: { type: Date, default: null },

  lastSuccessfulSyncAt: { type: Date, default: null },
  lastSyncError: { type: String, default: '', trim: true, maxlength: 500 },
  lastConnectionCheckAt: { type: Date, default: null },
  lastConnectionError: { type: String, default: '', trim: true, maxlength: 500 },
}, { timestamps: true });

BaseLinkerAccountSchema.index({ accountId: 1 }, { unique: true });
BaseLinkerAccountSchema.index({ tokenFingerprint: 1 }, { unique: true });
BaseLinkerAccountSchema.index({ enabled: 1, name: 1 });

module.exports = mongoose.model('BaseLinkerAccount', BaseLinkerAccountSchema);
