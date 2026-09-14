'use strict';

const mongoose = require('mongoose');

const ActorSchema = new mongoose.Schema({
  id: { type: String, default: '', trim: true, maxlength: 128 },
  name: { type: String, default: '', trim: true, maxlength: 256 },
  role: { type: String, default: '', trim: true, maxlength: 64 },
}, { _id: false });

const KsefOperationalEventSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now, required: true },
  kind: {
    type: String,
    required: true,
    enum: ['http_error', 'rate_limit', 'probe', 'restart_recovery', 'admin_retry', 'cleanup', 'scheduler_error'],
  },
  severity: { type: String, required: true, enum: ['info', 'warn', 'error'], default: 'info' },
  environment: { type: String, default: '', enum: ['', 'test', 'demo', 'prod'] },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', default: null },
  resourceType: { type: String, default: '', trim: true, maxlength: 64 },
  resourceId: { type: String, default: '', trim: true, maxlength: 160 },
  code: { type: String, default: '', trim: true, maxlength: 128 },
  httpStatus: { type: Number, default: null },
  providerCode: { type: String, default: '', trim: true, maxlength: 128 },
  method: { type: String, default: '', trim: true, maxlength: 16 },
  path: { type: String, default: '', trim: true, maxlength: 512 },
  message: { type: String, default: '', trim: true, maxlength: 1000 },
  retryAfter: { type: String, default: '', trim: true, maxlength: 128 },
  actor: { type: ActorSchema, default: null },
  details: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: false, versionKey: false });

KsefOperationalEventSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
KsefOperationalEventSchema.index({ kind: 1, at: -1 });
KsefOperationalEventSchema.index({ environment: 1, severity: 1, at: -1 });
KsefOperationalEventSchema.index({ resourceType: 1, resourceId: 1, at: -1 });

module.exports = mongoose.model('KsefOperationalEvent', KsefOperationalEventSchema);
