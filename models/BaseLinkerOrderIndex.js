'use strict';

const mongoose = require('mongoose');

// Minimal persistent queue index. It is deliberately NOT an order mirror:
// no products, customer data, addresses, shipment data or raw BaseLinker JSON
// are stored here. The row exists only so the worker UI can keep stable
// numbered pagination over the current configured Intake status.
const BaseLinkerOrderIndexSchema = new mongoose.Schema({
  orderId: { type: String, required: true },
  orderIdNumeric: { type: Number, required: true, index: true },
  syncToken: { type: String, default: '', index: true },
  seenAt: { type: Date, default: Date.now },
}, { timestamps: true });

BaseLinkerOrderIndexSchema.index({ orderId: 1 }, { unique: true });
BaseLinkerOrderIndexSchema.index({ orderIdNumeric: -1 });

module.exports = mongoose.model('BaseLinkerOrderIndex', BaseLinkerOrderIndexSchema);
