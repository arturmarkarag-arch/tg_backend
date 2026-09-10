'use strict';

const mongoose = require('mongoose');

const EncryptedSecretSchema = new mongoose.Schema({
  version: { type: Number, required: true, enum: [1] },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  ciphertext: { type: String, required: true },
}, { _id: false });

const AllegroAccountSchema = new mongoose.Schema({
  // Durable identity owned by our system. Allegro login/user id is metadata,
  // never the primary key used by the warehouse workflow.
  accountId: { type: String, required: true, trim: true, maxlength: 64 },

  // Business mapping requested by the warehouse: many Allegro seller accounts
  // may feed one BaseLinker account. This is not an Allegro API relationship.
  baseLinkerAccountId: { type: String, required: true, trim: true, maxlength: 64, index: true },

  name: { type: String, required: true, trim: true, maxlength: 160 },
  color: { type: String, default: '', trim: true, maxlength: 32 },
  enabled: { type: Boolean, default: false, index: true },

  authState: {
    type: String,
    enum: ['authorization_required', 'connected', 'expired', 'revoked', 'error'],
    default: 'authorization_required',
    index: true,
  },
  allegroUserId: { type: String, default: undefined, trim: true, maxlength: 128 },
  login: { type: String, default: '', trim: true, maxlength: 160 },
  marketplaceIds: { type: [String], default: [] },
  scopes: { type: [String], default: [] },

  // OAuth credentials are server-only and encrypted at rest. `select:false`
  // prevents accidental inclusion in ordinary reads/lean() snapshots.
  accessTokenEncrypted: { type: EncryptedSecretSchema, default: undefined, select: false },
  refreshTokenEncrypted: { type: EncryptedSecretSchema, default: undefined, select: false },
  tokenRevision: { type: Number, default: 0, min: 0 },
  tokenExpiresAt: { type: Date, default: null },
  tokenRefreshedAt: { type: Date, default: null },
  authConnectedAt: { type: Date, default: null },

  lastSuccessfulSyncAt: { type: Date, default: null },
  lastSyncError: { type: String, default: '', trim: true, maxlength: 1000 },
  lastConnectionCheckAt: { type: Date, default: null },
  lastConnectionError: { type: String, default: '', trim: true, maxlength: 1000 },
}, { timestamps: true });

AllegroAccountSchema.index({ accountId: 1 }, { unique: true });
// A real Allegro seller account must not be connected twice. Drafts have no
// Allegro user id and are excluded from this index.
AllegroAccountSchema.index({ allegroUserId: 1 }, { unique: true, sparse: true });
AllegroAccountSchema.index({ baseLinkerAccountId: 1, createdAt: 1 });
AllegroAccountSchema.index({ enabled: 1, authState: 1 });

module.exports = mongoose.model('AllegroAccount', AllegroAccountSchema);
