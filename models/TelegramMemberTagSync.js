'use strict';

const mongoose = require('mongoose');

/**
 * Durable dirty-marker / outbox for Telegram member tags.
 *
 * It deliberately does NOT persist authoritative shop/tag data. Each worker run
 * re-reads User -> Shop and the current main Telegram group before touching
 * Telegram, so queued work cannot apply stale assignment data.
 */
const schema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, trim: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'retry_wait', 'synced', 'skipped', 'failed'],
    default: 'pending',
    index: true,
  },
  requestedRevision: { type: Number, default: 1 },
  processingRevision: { type: Number, default: null },
  requestedAt: { type: Date, default: Date.now },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lastAttemptAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  source: { type: String, default: 'system', trim: true },

  // Diagnostic snapshot only; never used to compute the next desired state.
  lastChatId: { type: String, default: '' },
  lastUserId: { type: String, default: '' },
  lastShopId: { type: String, default: '' },
  lastShopName: { type: String, default: '' },
  telegramStatus: { type: String, default: '' },
  previousTag: { type: String, default: '' },
  desiredTag: { type: String, default: '' },
  lastResult: { type: String, default: '' },
  lastErrorCode: { type: String, default: '' },
  lastError: { type: String, default: '' },
}, { timestamps: true });

schema.index({ status: 1, nextAttemptAt: 1, requestedAt: 1 });

module.exports = mongoose.model('TelegramMemberTagSync', schema);
