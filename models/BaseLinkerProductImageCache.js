'use strict';

const mongoose = require('mongoose');

// Non-PII, read-optimized cache for the worker UI. We persist only the first
// product image and the resolution state, keyed by our account UUID + exact
// BaseLinker product identity. No order/customer payload is stored here.
const BaseLinkerProductImageCacheSchema = new mongoose.Schema({
  baseLinkerAccountId: { type: String, required: true, trim: true, maxlength: 64, index: true },
  productKey: { type: String, required: true, trim: true, maxlength: 512 },
  // Bump when image-resolution semantics change. Old negative rows must not
  // suppress newly available sources after deploy.
  resolverVersion: { type: Number, default: 0, index: true },
  state: { type: String, default: 'unresolved', trim: true, maxlength: 80 },
  imageUrl: { type: String, default: '', maxlength: 4096 },
  source: { type: String, default: '', trim: true, maxlength: 80 },
  confidence: { type: Number, default: null, min: 0, max: 1 },
  refreshedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

BaseLinkerProductImageCacheSchema.index({ baseLinkerAccountId: 1, productKey: 1 }, { unique: true });

module.exports = mongoose.model('BaseLinkerProductImageCache', BaseLinkerProductImageCacheSchema);
