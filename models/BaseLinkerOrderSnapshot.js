'use strict';

const mongoose = require('mongoose');

// Content-addressed immutable audit snapshots of the exact parsed order rows
// returned by BaseLinker. Business/picking state never overwrites these rows.
const BaseLinkerOrderSnapshotSchema = new mongoose.Schema({
  orderId: { type: String, required: true, index: true },
  snapshotHash: { type: String, required: true, maxlength: 64 },
  source: { type: String, default: 'unknown', maxlength: 64 },
  observedAt: { type: Date, default: Date.now, index: true },
  order: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: false });

BaseLinkerOrderSnapshotSchema.index(
  { orderId: 1, snapshotHash: 1 },
  { unique: true },
);
BaseLinkerOrderSnapshotSchema.index({ orderId: 1, observedAt: -1 });

module.exports = mongoose.model('BaseLinkerOrderSnapshot', BaseLinkerOrderSnapshotSchema);
