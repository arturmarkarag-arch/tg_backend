'use strict';

const mongoose = require('mongoose');

// Internet-store inventory is an independent stock domain. It may be seeded from
// a warehouse Product when the commerce item is first copied, but it never reads
// Product.quantity as a live source of truth afterwards.
const CommerceInventoryItemSchema = new mongoose.Schema({
  commerceProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommerceProduct', required: true, unique: true, index: true },
  onHand: { type: Number, min: 0, default: 0 },
  status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
  source: { type: String, enum: ['manual', 'warehouse_copy', 'migration'], default: 'manual' },
  sourceWarehouseProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
  sourceSnapshotAt: { type: Date, default: null },
  createdByTelegramId: { type: String, default: '' },
  createdByName: { type: String, default: '' },
  updatedByTelegramId: { type: String, default: '' },
  updatedByName: { type: String, default: '' },
}, { timestamps: true });

CommerceInventoryItemSchema.pre('validate', function normalizeQuantity(next) {
  const n = Number(this.onHand || 0);
  this.onHand = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  next();
});

module.exports = mongoose.model('CommerceInventoryItem', CommerceInventoryItemSchema);
