'use strict';

const mongoose = require('mongoose');

const AllegroErrorItemSchema = new mongoose.Schema({
  code: { type: String, default: '', trim: true, maxlength: 200 },
  message: { type: String, default: '', trim: true, maxlength: 1500 },
  userMessage: { type: String, default: '', trim: true, maxlength: 1500 },
  details: { type: String, default: '', trim: true, maxlength: 1500 },
  fieldPath: { type: String, default: '', trim: true, maxlength: 500 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { _id: false });

const AllegroApiErrorLogSchema = new mongoose.Schema({
  eventId: { type: String, required: true, trim: true, maxlength: 64 },
  accountId: { type: String, required: true, trim: true, maxlength: 64, index: true },
  method: { type: String, required: true, trim: true, maxlength: 16 },
  path: { type: String, required: true, trim: true, maxlength: 500 },
  stage: { type: String, default: 'other', trim: true, maxlength: 100 },
  httpStatus: { type: Number, default: 0 },
  code: { type: String, default: '', trim: true, maxlength: 200 },
  message: { type: String, default: '', trim: true, maxlength: 1500 },
  userMessage: { type: String, default: '', trim: true, maxlength: 1500 },
  details: { type: String, default: '', trim: true, maxlength: 1500 },
  fieldPath: { type: String, default: '', trim: true, maxlength: 500 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: undefined },
  upstreamErrors: { type: [AllegroErrorItemSchema], default: [] },
  traceId: { type: String, default: '', trim: true, maxlength: 256, index: true },
  retryable: { type: Boolean, default: false },
  retryAfterMs: { type: Number, default: null },
  attempt: { type: Number, default: 1, min: 1 },
  requestId: { type: String, default: '', trim: true, maxlength: 64 },
  occurredAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: false, versionKey: false });

AllegroApiErrorLogSchema.index({ eventId: 1 }, { unique: true });
AllegroApiErrorLogSchema.index({ accountId: 1, occurredAt: -1 });
AllegroApiErrorLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AllegroApiErrorLog', AllegroApiErrorLogSchema);
