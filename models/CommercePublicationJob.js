'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const CommercePublicationJobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true, default: () => crypto.randomUUID() },
  idempotencyKey: { type: String, required: true, unique: true, trim: true },
  provider: { type: String, required: true, trim: true, lowercase: true },
  action: { type: String, required: true, trim: true },
  commerceProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommerceProduct', required: true, index: true },
  channelListingId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChannelListing', required: true, index: true },
  accountId: { type: String, required: true, trim: true, index: true },
  externalKey: { type: String, trim: true, default: '' },
  requestHash: { type: String, trim: true, default: '' },
  state: {
    type: String,
    enum: ['reserved', 'sending', 'pending', 'confirmed', 'failed', 'unknown'],
    default: 'reserved',
    index: true,
  },
  lockToken: { type: String, default: '' },
  providerEntityId: { type: String, trim: true, default: '' },
  providerOperationPath: { type: String, trim: true, default: '' },
  providerOperationId: { type: String, trim: true, default: '' },
  providerTraceId: { type: String, trim: true, default: '' },
  providerRequestId: { type: String, trim: true, default: '' },
  providerStatus: { type: String, trim: true, default: '' },
  attempts: { type: Number, min: 0, default: 0 },
  lastAttemptAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  lastErrorCode: { type: String, trim: true, default: '' },
  lastError: { type: String, default: '' },
  lastHttpStatus: { type: Number, default: 0 },
  resultSnapshot: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { timestamps: true });

CommercePublicationJobSchema.index({ provider: 1, accountId: 1, state: 1, updatedAt: -1 });
CommercePublicationJobSchema.index({ channelListingId: 1, action: 1, updatedAt: -1 });

module.exports = mongoose.model('CommercePublicationJob', CommercePublicationJobSchema);
