'use strict';

const mongoose = require('mongoose');

// Minimal persistent queue index. It is deliberately NOT an order mirror:
// no products, personal data, addresses, shipment data or raw BaseLinker JSON
// are stored here. The row exists only so the worker UI can keep stable
// numbered pagination and counts over the current BaseLinker intake status.
// Sent/Cancelled history belongs to BaseLinkerPickingOrder, not to an upstream mirror.
const BaseLinkerOrderIndexSchema = new mongoose.Schema({
  baseLinkerAccountId: { type: String, required: true, trim: true, maxlength: 64, index: true },
  orderId: { type: String, required: true },
  orderIdNumeric: { type: Number, required: true, index: true },
  // Cross-account ordering must not compare unrelated order_id sequences.
  // This non-PII timestamp comes from BaseLinker date_confirmed/date_add.
  orderSortDate: { type: Number, default: 0, index: true },
  // Non-PII source identity for truthful server-side filtering/pagination.
  sourceType: { type: String, default: '', trim: true, lowercase: true, maxlength: 80, index: true },
  sourceId: { type: String, default: '', trim: true, maxlength: 120, index: true },
  syncToken: { type: String, default: '', index: true },
  seenAt: { type: Date, default: Date.now },
}, { timestamps: true });

BaseLinkerOrderIndexSchema.index({ baseLinkerAccountId: 1, orderId: 1 }, { unique: true });
BaseLinkerOrderIndexSchema.index({ orderSortDate: -1, orderIdNumeric: -1, baseLinkerAccountId: 1 });
BaseLinkerOrderIndexSchema.index({ baseLinkerAccountId: 1, sourceType: 1, sourceId: 1, orderSortDate: -1, orderIdNumeric: -1 });

module.exports = mongoose.model('BaseLinkerOrderIndex', BaseLinkerOrderIndexSchema);
