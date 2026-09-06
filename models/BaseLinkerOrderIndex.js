'use strict';

const mongoose = require('mongoose');

// Minimal persistent queue index. It is deliberately NOT an order mirror:
// no products, personal data, addresses, shipment data or raw BaseLinker JSON
// are stored here. The row exists only so the worker UI can keep stable
// numbered pagination and counts over Intake plus the two 14-day history shelves.
const BaseLinkerOrderIndexSchema = new mongoose.Schema({
  orderId: { type: String, required: true },
  orderIdNumeric: { type: Number, required: true, index: true },
  upstreamDisposition: {
    type: String,
    enum: ['intake', 'sent', 'cancelled'],
    default: 'intake',
    index: true,
  },
  // BaseLinker's status-transition timestamp. It is kept only for the bounded
  // Sent/Cancelled membership decision; Intake rows use 0.
  dateInStatus: { type: Number, default: 0 },
  syncToken: { type: String, default: '', index: true },
  seenAt: { type: Date, default: Date.now },
}, { timestamps: true });

BaseLinkerOrderIndexSchema.index({ orderId: 1 }, { unique: true });
BaseLinkerOrderIndexSchema.index({ orderIdNumeric: -1 });
BaseLinkerOrderIndexSchema.index({ upstreamDisposition: 1, orderIdNumeric: -1 });

module.exports = mongoose.model('BaseLinkerOrderIndex', BaseLinkerOrderIndexSchema);
