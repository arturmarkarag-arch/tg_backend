'use strict';

const mongoose = require('mongoose');

const AllegroShipmentBindingSchema = new mongoose.Schema({
  accountId: { type: String, required: true, trim: true, maxlength: 64, index: true },
  orderId: { type: String, required: true, trim: true, maxlength: 128, index: true },
  commandId: { type: String, default: '', trim: true, maxlength: 96, index: true },
  shipmentId: { type: String, default: '', trim: true, maxlength: 128, index: true },
  status: {
    type: String,
    enum: ['idle', 'pending', 'success', 'error'],
    default: 'idle',
    index: true,
  },
  labelFormat: { type: String, default: '', trim: true, maxlength: 24 },
  carrierId: { type: String, default: '', trim: true, maxlength: 80 },
  waybills: { type: [String], default: [] },
  lastError: { type: String, default: '', trim: true, maxlength: 1500 },
  lastTraceId: { type: String, default: '', trim: true, maxlength: 256 },
  lastCommandCheckAt: { type: Date, default: null },
  nextCommandCheckAt: { type: Date, default: null },
}, { timestamps: true });

AllegroShipmentBindingSchema.index({ accountId: 1, orderId: 1 }, { unique: true });
AllegroShipmentBindingSchema.index({ commandId: 1 }, { unique: true, sparse: true });
AllegroShipmentBindingSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AllegroShipmentBinding', AllegroShipmentBindingSchema);
