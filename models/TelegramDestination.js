'use strict';

const mongoose = require('mongoose');

const TelegramDestinationSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  chatId: { type: String, default: '' },
  enabled: { type: Boolean, default: false },
  title: { type: String, default: '' },
  chatType: { type: String, default: '' },
  botStatus: { type: String, default: '' },
  canPost: { type: Boolean, default: false },
  canEdit: { type: Boolean, default: false },
  canDelete: { type: Boolean, default: false },
  healthCode: { type: String, default: 'not_configured' },
  healthDescription: { type: String, default: '' },
  lastHealthCheckAt: { type: Date, default: null },
  lastMembershipEventAt: { type: Date, default: null },
  configRevision: { type: Number, default: 0, min: 0 },
  changedAt: { type: Date, default: null },
  changedBy: { type: String, default: '' },
  migratedFromAppSettingAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('TelegramDestination', TelegramDestinationSchema);
