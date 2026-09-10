'use strict';

const mongoose = require('mongoose');
const { OPERATIONAL_HISTORY_RETENTION_SECONDS } = require('../utils/retentionPolicy');

const schema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  userId: { type: String, default: '' },
  shopId: { type: String, default: '' },
  shopName: { type: String, default: '' },
  chatId: { type: String, default: '' },
  telegramStatus: { type: String, default: '' },
  previousTag: { type: String, default: '' },
  desiredTag: { type: String, default: '' },
  result: { type: String, required: true, index: true },
  source: { type: String, default: 'system' },
  requestedRevision: { type: Number, default: null },
  errorCode: { type: String, default: '' },
  error: { type: String, default: '' },
  retryAfterSeconds: { type: Number, default: null },
  retryAt: { type: Date, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ telegramId: 1, createdAt: -1 });
schema.index({ result: 1, createdAt: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: OPERATIONAL_HISTORY_RETENTION_SECONDS });

module.exports = mongoose.model('TelegramMemberTagSyncEvent', schema);
