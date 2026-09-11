'use strict';

const mongoose = require('mongoose');

const IDENTIFIER_KINDS = ['gtin', 'ean', 'upc', 'isbn', 'issn', 'mpn', 'custom'];

const IdentifierSchema = new mongoose.Schema({
  kind: { type: String, enum: IDENTIFIER_KINDS, default: 'custom' },
  value: { type: String, trim: true, required: true },
  normalized: { type: String, select: false, default: '' },
  label: { type: String, trim: true, default: '' },
  primary: { type: Boolean, default: false },
  source: { type: String, enum: ['catalog', 'warehouse', 'provider', 'manual'], default: 'manual' },
}, { _id: false });

const MediaSchema = new mongoose.Schema({
  type: { type: String, enum: ['image'], default: 'image' },
  url: { type: String, trim: true, default: '' },
  alt: { type: String, trim: true, default: '' },
  source: { type: String, enum: ['catalog', 'warehouse', 'provider', 'manual'], default: 'catalog' },
  role: { type: String, enum: ['primary', 'gallery'], default: 'gallery' },
  position: { type: Number, min: 0, default: 0 },
  sourceRef: { type: String, trim: true, default: '' },
}, { _id: false });

const AttributeValueSchema = new mongoose.Schema({
  key: { type: String, trim: true, required: true },
  label: { type: String, trim: true, default: '' },
  valueType: { type: String, enum: ['text', 'number', 'boolean', 'select', 'multi_select'], default: 'text' },
  value: { type: mongoose.Schema.Types.Mixed, default: '' },
  unit: { type: String, trim: true, default: '' },
  group: { type: String, trim: true, default: '' },
  position: { type: Number, min: 0, default: 0 },
  source: { type: String, enum: ['catalog', 'warehouse', 'provider', 'manual'], default: 'manual' },
}, { _id: false });

const DimensionsSchema = new mongoose.Schema({
  lengthMm: { type: Number, min: 0, default: 0 },
  widthMm: { type: Number, min: 0, default: 0 },
  heightMm: { type: Number, min: 0, default: 0 },
}, { _id: false });

const PhysicalSchema = new mongoose.Schema({
  weightG: { type: Number, min: 0, default: 0 },
  packageWeightG: { type: Number, min: 0, default: 0 },
  dimensions: { type: DimensionsSchema, default: () => ({}) },
  packageDimensions: { type: DimensionsSchema, default: () => ({}) },
}, { _id: false });

// Historical/source linkage only. This must never be used as live Commerce stock.
const WarehouseBindingSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  unitsPerItem: { type: Number, min: 0.000001, default: 1 },
  stockBuffer: { type: Number, min: 0, default: 0 },
  enabled: { type: Boolean, default: true },
}, { _id: false });

const CommerceProductSchema = new mongoose.Schema({
  sku: { type: String, trim: true, default: '' },
  skuKey: { type: String, select: false, default: '' },
  // Legacy compatibility field consumed by existing provider adapters. Product
  // Master keeps identifiers[] as the canonical multi-code representation.
  ean: { type: String, trim: true, default: '' },
  eanKey: { type: String, select: false, default: '' },
  identifiers: { type: [IdentifierSchema], default: [] },
  name: { type: String, trim: true, required: true },
  description: { type: String, trim: true, default: '' },
  brand: { type: String, trim: true, default: '' },
  language: { type: String, trim: true, default: 'pl-PL' },
  condition: { type: String, enum: ['unknown', 'new', 'used', 'refurbished'], default: 'unknown' },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommerceCategory', default: null, index: true },
  basePrice: { type: Number, min: 0, default: 0 },
  currency: { type: String, trim: true, uppercase: true, default: 'PLN' },
  media: { type: [MediaSchema], default: [] },
  // Legacy free-form map retained while provider adapters migrate to canonical
  // attributeValues. Provider-specific attributes belong to ChannelListing.
  attributes: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  attributeValues: { type: [AttributeValueSchema], default: [] },
  physical: { type: PhysicalSchema, default: () => ({}) },
  // Provenance/source links for products copied from the main warehouse. Commerce
  // inventory lives separately in CommerceInventoryItem.
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
  this.language = String(this.language || 'pl-PL').trim() || 'pl-PL';
  next();
});

CommerceProductSchema.index(
  { skuKey: 1 },
  { unique: true, partialFilterExpression: { skuKey: { $gt: '' } } },
);
CommerceProductSchema.index({ eanKey: 1 });
CommerceProductSchema.index({ 'identifiers.normalized': 1 });
CommerceProductSchema.index({ status: 1, updatedAt: -1 });
CommerceProductSchema.index({ categoryId: 1, status: 1 });
CommerceProductSchema.index({ 'warehouseBindings.productId': 1 });
CommerceProductSchema.index(
  { directWarehouseProductId: 1 },
  { unique: true, partialFilterExpression: { directWarehouseProductId: { $type: 'objectId' } } },
);
CommerceProductSchema.index({ name: 'text', brand: 'text', sku: 'text', ean: 'text' });

module.exports = mongoose.model('CommerceProduct', CommerceProductSchema);
