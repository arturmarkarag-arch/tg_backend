'use strict';

const mongoose = require('mongoose');

const AllegroOrderSyncStateSchema = new mongoose.Schema({
  accountId: { type: String, required: true, trim: true, maxlength: 64, unique: true, index: true },
  initialized: { type: Boolean, default: false, index: true },
  bootstrapState: {
    type: String,
    enum: ['pending', 'running', 'complete', 'error'],
    default: 'pending',
    index: true,
  },
  cursorEventId: { type: String, default: '', trim: true, maxlength: 128 },
  cursorOccurredAt: { type: Date, default: null },
  bootstrapBarrierEventId: { type: String, default: '', trim: true, maxlength: 128 },
  bootstrapBarrierOccurredAt: { type: Date, default: null },
  lastPollAt: { type: Date, default: null },
  lastSuccessfulPollAt: { type: Date, default: null, index: true },
  lastBootstrapAt: { type: Date, default: null },
  lastEventCount: { type: Number, default: 0, min: 0 },
  lastOrderRefreshCount: { type: Number, default: 0, min: 0 },
  consecutiveFailures: { type: Number, default: 0, min: 0 },
  lastError: { type: String, default: '', trim: true, maxlength: 1500 },
}, { timestamps: true });

module.exports = mongoose.model('AllegroOrderSyncState', AllegroOrderSyncStateSchema);
