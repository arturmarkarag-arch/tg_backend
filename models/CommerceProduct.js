'use strict';

const mongoose = require('mongoose');

const MediaSchema = new mongoose.Schema({
  type: { type: String, enum: ['image'], default: 'image' },
  url: { type: String, trim: true, default: '' },
  alt: { type: String, trim: true, default: '' },
  source: { type: String, enum: ['catalog', 'warehouse', 'provider'], default: 'catalog' },
}, { _id: false });

const WarehouseBindingSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  unitsPerItem: { type: Number, min: 0.000001, default: 1 },
  stockBuffer: { type: Number, min: 0, default: 0 },
  enabled: { type: Boolean, default: true },
}, { _id: false });

const CommerceProductSchema = new mongoose.Schema({
  sku: { type: String, trim: true, default: '' },
  skuKey: { type: String, select: false, default: '' },
  ean: { type: String, trim: true, default: '' },
  eanKey: { type: String, select: false, default: '' },
  name: { type: String, trim: true, required: true },
  description: { type: String, trim: true, default: '' },
  brand: { type: String, trim: true, default: '' },
  basePrice: { type: Number, min: 0, default: 0 },
  currency: { type: String, trim: true, uppercase: true, default: 'PLN' },
  media: { type: [MediaSchema], default: [] },
  attributes: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  warehouseBindings: { type: [WarehouseBindingSchema], default: [] },
  // Idempotency anchor for the simple one-warehouse-product -> one-commerce-product import path.
  // Bundles/future composite products must use a different BOM layer and are not constrained by this field.
  directWarehouseProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: undefined, select: false },
  status: { type: String, enum: ['draft', 'active', 'archived'], default: 'draft' },
  source: { type: String, enum: ['manual', 'warehouse_import'], default: 'manual' },
  createdByTelegramId: { type: String, default: '' },
  createdByName: { type: String, default: '' },
  updatedByTelegramId: { type: String, default: '' },
  updatedByName: { type: String, default: '' },
}, { timestamps: true });

CommerceProductSchema.pre('validate', function normalizeKeys(next) {
  this.sku = String(this.sku || '').trim();
  this.skuKey = this.sku.toLocaleUpperCase('en-US');
  this.ean = String(this.ean || '').trim();
  this.eanKey = this.ean.replace(/\s+/g, '');
  this.currency = String(this.currency || 'PLN').trim().toUpperCase() || 'PLN';
  next();
});

CommerceProductSchema.index(
  { skuKey: 1 },
  { unique: true, partialFilterExpression: { skuKey: { $gt: '' } } },
);
CommerceProductSchema.index({ eanKey: 1 });
CommerceProductSchema.index({ status: 1, updatedAt: -1 });
CommerceProductSchema.index({ 'warehouseBindings.productId': 1 });
CommerceProductSchema.index(
  { directWarehouseProductId: 1 },
  { unique: true, partialFilterExpression: { directWarehouseProductId: { $type: 'objectId' } } },
);
CommerceProductSchema.index({ name: 'text', brand: 'text', sku: 'text', ean: 'text' });

module.exports = mongoose.model('CommerceProduct', CommerceProductSchema);
