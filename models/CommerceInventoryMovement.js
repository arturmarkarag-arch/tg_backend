'use strict';

const mongoose = require('mongoose');

// Durable exactly-once reconciliation record for the independent internet-store
// inventory. It never mutates or mirrors the main warehouse Product.quantity.
const CommerceInventoryMovementSchema = new mongoose.Schema({
  movementKey: { type: String, required: true, trim: true, maxlength: 180, unique: true, index: true },
  commerceProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommerceProduct', required: true, index: true },
  commerceInventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommerceInventoryItem', default: null, index: true },
  type: { type: String, enum: ['marketplace_order_consumption'], required: true, index: true },
  sourceReservationKey: { type: String, trim: true, required: true, maxlength: 128, index: true },
  canonicalProvider: { type: String, trim: true, lowercase: true, default: '', maxlength: 40 },
  canonicalOrderId: { type: String, trim: true, default: '', maxlength: 180 },
  targetQuantity: { type: Number, min: 0, default: 0 },
  appliedQuantity: { type: Number, min: 0, default: 0 },
  state: { type: String, enum: ['applied', 'blocked'], default: 'blocked', index: true },
  issueCode: { type: String, trim: true, default: '', maxlength: 120 },
  issueMessage: { type: String, trim: true, default: '', maxlength: 1000 },
  beforeOnHand: { type: Number, min: 0, default: null },
  afterOnHand: { type: Number, min: 0, default: null },
  appliedAt: { type: Date, default: null },
}, { timestamps: true });

CommerceInventoryMovementSchema.index({ commerceProductId: 1, type: 1, updatedAt: -1 });
CommerceInventoryMovementSchema.index({ state: 1, updatedAt: -1 });

module.exports = mongoose.model('CommerceInventoryMovement', CommerceInventoryMovementSchema);
