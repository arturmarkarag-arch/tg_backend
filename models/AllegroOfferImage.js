'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  accountId: { type: String, required: true },
  offerId: { type: String, required: true },
  images: { type: [String], default: [] },
  source: { type: String, default: '' },
  checkedAt: { type: Date, default: null },
  nextCheckAt: { type: Date, required: true },
  lastError: { type: String, default: '', maxlength: 160 },
}, { timestamps: true });
schema.index({ accountId: 1, offerId: 1 }, { unique: true });
schema.index({ updatedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
module.exports = mongoose.model('AllegroOfferImage', schema);
