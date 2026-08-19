'use strict';

const mongoose = require('mongoose');

const TelegramNotificationEventSchema = new mongoose.Schema({
  eventKey: { type: String, required: true, unique: true, trim: true },
  kind: { type: String, required: true, trim: true },
  sourceType: { type: String, required: true, trim: true },
  sourceId: { type: String, required: true, trim: true },
  sourceRevision: { type: Number, default: 1 },
  deliveryGroupId: { type: String, default: '', index: true },
  status: {
    type: String,
    enum: ['pending', 'delivering', 'completed'],
    default: 'pending',
    index: true,
  },
  preparedAt: { type: Date, required: true },
  scheduledAt: { type: Date, default: null, index: true },
  firstAttemptAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  recipientCount: { type: Number, default: 0 },
  privateCount: { type: Number, default: 0 },
  groupCount: { type: Number, default: 0 },
  sentCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  skippedCount: { type: Number, default: 0 },
  possibleDuplicateCount: { type: Number, default: 0 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

TelegramNotificationEventSchema.index({ sourceType: 1, sourceId: 1, kind: 1, sourceRevision: 1 });
TelegramNotificationEventSchema.index({ deliveryGroupId: 1, preparedAt: -1 });

module.exports = mongoose.model('TelegramNotificationEvent', TelegramNotificationEventSchema);
