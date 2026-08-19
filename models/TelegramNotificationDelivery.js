'use strict';

const mongoose = require('mongoose');

const LastErrorSchema = new mongoose.Schema({
  at: { type: Date, default: null },
  statusCode: { type: Number, default: null },
  libraryCode: { type: String, default: '' },
  description: { type: String, default: '' },
  retryable: { type: Boolean, default: false },
  ambiguous: { type: Boolean, default: false },
}, { _id: false });

const TelegramNotificationDeliverySchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramNotificationEvent', required: true, index: true },
  eventKey: { type: String, required: true, trim: true },
  channel: { type: String, enum: ['private', 'group'], required: true },
  recipientId: { type: String, required: true, trim: true },
  recipientName: { type: String, default: '' },
  recipientShopId: { type: String, default: '' },
  recipientShopName: { type: String, default: '' },
  text: { type: String, required: true },
  eligibilityType: { type: String, enum: ['', 'ordering_catalog_review_pending'], default: '' },
  eligibilitySessionId: { type: String, default: '' },
  eligibilityGroupId: { type: String, default: '' },
  status: {
    type: String,
    enum: ['pending', 'sending', 'retry_wait', 'sent', 'failed', 'skipped'],
    default: 'pending',
    index: true,
  },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  leaseUntil: { type: Date, default: null, index: true },
  lastAttemptAt: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  telegramMessageId: { type: Number, default: null },
  telegramDate: { type: Date, default: null },
  possibleDuplicate: { type: Boolean, default: false },
  skipReason: { type: String, default: '' },
  lastError: { type: LastErrorSchema, default: () => ({}) },
}, { timestamps: true });

TelegramNotificationDeliverySchema.index(
  { eventKey: 1, channel: 1, recipientId: 1 },
  { unique: true },
);
TelegramNotificationDeliverySchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
TelegramNotificationDeliverySchema.index({ recipientId: 1, createdAt: -1 });
TelegramNotificationDeliverySchema.index({ eligibilitySessionId: 1, recipientId: 1, createdAt: -1 });

module.exports = mongoose.model('TelegramNotificationDelivery', TelegramNotificationDeliverySchema);
