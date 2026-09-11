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
  nextRetryAt: { type: Date, default: null, index: true },
  lastSuccessfulPollAt: { type: Date, default: null, index: true },
  caughtUp: { type: Boolean, default: false },
  lastCaughtUpAt: { type: Date, default: null },
  lastReconcileAt: { type: Date, default: null },
  reconcileError: { type: String, default: '', maxlength: 160 },
  imageError: { type: String, default: '', maxlength: 160 },
  nextImageRetryAt: { type: Date, default: null },
  lastBootstrapAt: { type: Date, default: null },
  lastEventCount: { type: Number, default: 0, min: 0 },
  lastOrderRefreshCount: { type: Number, default: 0, min: 0 },
  consecutiveFailures: { type: Number, default: 0, min: 0 },
  lastError: { type: String, default: '', trim: true, maxlength: 1500 },
  lastErrorCode: { type: String, default: '', trim: true, maxlength: 160 },
  lastErrorTraceId: { type: String, default: '', trim: true, maxlength: 256 },
  lastErrorHttpStatus: { type: Number, default: null },
}, { timestamps: true });

module.exports = mongoose.model('AllegroOrderSyncState', AllegroOrderSyncStateSchema);
