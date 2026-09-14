'use strict';

const mongoose = require('mongoose');

const ErrorSchema = new mongoose.Schema({
  code: { type: String, default: '' },
  message: { type: String, default: '' },
  httpStatus: { type: Number, default: null },
  providerCode: { type: String, default: '' },
  details: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const KsefInboundSyncStateSchema = new mongoose.Schema({
  syncId: { type: String, required: true, trim: true, maxlength: 64 },
  provider: { type: String, required: true, default: 'ksef', enum: ['ksef'] },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', required: true },
  environment: { type: String, required: true, enum: ['test', 'demo', 'prod'] },
  subjectType: { type: String, required: true, enum: ['Subject2'], default: 'Subject2' },
  enabled: { type: Boolean, default: true, index: true },

  authMethod: { type: String, required: true, enum: ['token_connection', 'xades'] },
  authRefId: { type: String, required: true, trim: true, maxlength: 128 },

  state: { type: String, enum: ['idle', 'running', 'retry_wait', 'export_wait', 'manual_review'], default: 'idle' },
  cursorFrom: { type: Date, required: true },
  activeWindowTo: { type: Date, default: null },
  pageOffset: { type: Number, default: 0, min: 0 },
  pageSize: { type: Number, default: 250, min: 1, max: 250 },
  lastPermanentStorageHwmDate: { type: Date, default: null },

  attempts: { type: Number, default: 0, min: 0 },
  nextSyncAt: { type: Date, default: null },
  leaseUntil: { type: Date, default: null },
  lastAttemptAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastError: { type: ErrorSchema, default: null },

  stats: {
    metadataSeen: { type: Number, default: 0, min: 0 },
    documentsCreated: { type: Number, default: 0, min: 0 },
    metadataUpdated: { type: Number, default: 0, min: 0 },
    conflicts: { type: Number, default: 0, min: 0 },
  },
}, { timestamps: true, optimisticConcurrency: true });

KsefInboundSyncStateSchema.index({ syncId: 1 }, { unique: true });
KsefInboundSyncStateSchema.index({ legalEntityId: 1, environment: 1, subjectType: 1 }, { unique: true });
KsefInboundSyncStateSchema.index({ enabled: 1, state: 1, nextSyncAt: 1, leaseUntil: 1 });

module.exports = mongoose.model('KsefInboundSyncState', KsefInboundSyncStateSchema);
