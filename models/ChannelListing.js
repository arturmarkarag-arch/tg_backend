'use strict';

const mongoose = require('mongoose');

const ChannelListingSchema = new mongoose.Schema({
  commerceProductId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CommerceProduct',
    required: true,
    index: true,
  },
  provider: { type: String, trim: true, lowercase: true, required: true },
  accountId: { type: String, trim: true, required: true },
  // Durable dedupe key. Kept separate from the existing lookup index so Stage 3A
  // can add uniqueness without replacing a production Mongo index in place.
  identityKey: { type: String, default: '', select: false },
  externalId: { type: String, trim: true, default: '' },
  externalUrl: { type: String, trim: true, default: '' },
  channelSku: { type: String, trim: true, default: '' },
  status: {
    type: String,
    enum: ['draft', 'validation_error', 'queued', 'publishing', 'active', 'paused', 'ended', 'error'],
    default: 'draft',
  },
  titleOverride: { type: String, trim: true, default: '' },
  descriptionOverride: { type: String, default: '' },
  category: {
    id: { type: String, trim: true, default: '' },
    name: { type: String, trim: true, default: '' },
    path: { type: [String], default: [] },
  },
  attributes: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  price: {
    mode: { type: String, enum: ['inherit', 'override'], default: 'inherit' },
    value: { type: Number, min: 0, default: null },
    currency: { type: String, trim: true, uppercase: true, default: '' },
  },
  stock: {
    mode: { type: String, enum: ['inherit', 'fixed', 'capped'], default: 'inherit' },
    fixedQuantity: { type: Number, min: 0, default: null },
    maxQuantity: { type: Number, min: 0, default: null },
    buffer: { type: Number, min: 0, default: 0 },
  },
  syncState: {
    state: {
      type: String,
      enum: ['never', 'in_sync', 'pending', 'out_of_sync', 'retry_wait', 'failed', 'unknown'],
      default: 'never',
    },
    desiredHash: { type: String, default: '' },
    appliedHash: { type: String, default: '' },
    lastSyncAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
  },
  providerData: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { timestamps: true });

ChannelListingSchema.pre('validate', function normalizeIdentity(next) {
  this.provider = String(this.provider || '').trim().toLowerCase();
  this.accountId = String(this.accountId || '').trim();
  this.identityKey = this.commerceProductId && this.provider && this.accountId
    ? `${String(this.commerceProductId)}:${this.provider}:${this.accountId}`
    : '';
  next();
});

ChannelListingSchema.index({ commerceProductId: 1, provider: 1, accountId: 1 });
ChannelListingSchema.index(
  { identityKey: 1 },
  { unique: true, partialFilterExpression: { identityKey: { $gt: '' } } },
);
ChannelListingSchema.index({ provider: 1, accountId: 1, status: 1, updatedAt: -1 });
ChannelListingSchema.index(
  { provider: 1, accountId: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $gt: '' } } },
);

module.exports = mongoose.model('ChannelListing', ChannelListingSchema);
