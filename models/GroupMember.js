'use strict';
const mongoose = require('mongoose');

// Tracks Telegram users seen in authorized group chats.
// Populated passively: every message + join event updates this record.
const schema = new mongoose.Schema({
  groupChatId:  { type: String, required: true },
  telegramId:   { type: String, required: true },
  username:     { type: String, default: '' },
  firstName:    { type: String, default: '' },
  lastName:     { type: String, default: '' },
  photoFileId:  { type: String, default: '' },
  isBot:        { type: Boolean, default: false },
  lastSeenAt:   { type: Date, default: Date.now },
  joinedAt:     { type: Date, default: null },
  // true = user left/was kicked; false = still member
  left:         { type: Boolean, default: false },
}, { timestamps: true });

schema.index({ groupChatId: 1, telegramId: 1 }, { unique: true });
schema.index({ telegramId: 1 });

module.exports = mongoose.model('GroupMember', schema);
