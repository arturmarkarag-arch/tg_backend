'use strict';

const mongoose = require('mongoose');

const AllegroOAuthStateSchema = new mongoose.Schema({
  // Never persist the bearer `state` value itself. A callback proves possession
  // of the random value; Mongo stores only its SHA-256 digest.
  stateHash: { type: String, required: true, trim: true, maxlength: 64 },
  accountId: { type: String, required: true, trim: true, maxlength: 64, index: true },
  requestedByTelegramId: { type: String, default: '', trim: true, maxlength: 64 },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

AllegroOAuthStateSchema.index({ stateHash: 1 }, { unique: true });
AllegroOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
AllegroOAuthStateSchema.index({ accountId: 1, createdAt: -1 });

module.exports = mongoose.model('AllegroOAuthState', AllegroOAuthStateSchema);
