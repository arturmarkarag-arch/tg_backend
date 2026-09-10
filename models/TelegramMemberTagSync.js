'use strict';

const mongoose = require('mongoose');

/**
 * Durable projection outbox keyed by Telegram user + Telegram group.
 * One bad/missing group can retry independently without blocking the same user in
 * every other configured bot group. Authoritative tag data is never stored here:
 * normal sync always re-reads User -> Shop at execution time.
 */
const schema = new mongoose.Schema({
  telegramId: { type: String, required: true, trim: true, index: true },
  chatId: { type: String, required: true, trim: true, index: true },
  mode: { type: String, enum: ['sync', 'cleanup'], default: 'sync' },
  cleanupTag: { type: String, default: '' },
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

  // Diagnostic/ownership snapshot only; never used to derive normal desired state.
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

schema.index({ telegramId: 1, chatId: 1 }, { unique: true, name: 'telegram_member_tag_target_unique' });
schema.index({ status: 1, nextAttemptAt: 1, requestedAt: 1 });

module.exports = mongoose.model('TelegramMemberTagSync', schema);
