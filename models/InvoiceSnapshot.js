'use strict';

const mongoose = require('mongoose');

const ActorSchema = new mongoose.Schema({
  id: { type: String, default: '' },
  name: { type: String, default: '' },
  role: { type: String, default: '' },
}, { _id: false });

const InvoiceSnapshotSchema = new mongoose.Schema({
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, immutable: true },
  coreVersion: { type: Number, required: true, immutable: true },
  invoiceVersion: { type: Number, required: true, immutable: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  sha256: { type: String, required: true, immutable: true },
  finalizedBy: { type: ActorSchema, default: () => ({}), immutable: true },
}, {
  timestamps: { createdAt: true, updatedAt: false },
});

InvoiceSnapshotSchema.index({ invoiceId: 1 }, { unique: true });
InvoiceSnapshotSchema.index({ sha256: 1 });

module.exports = mongoose.model('InvoiceSnapshot', InvoiceSnapshotSchema);
