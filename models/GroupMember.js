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
  // The group welcome ("register here") message we posted for this member, so we
  // can delete it once they register. message_id null = none outstanding.
  // (Telegram only lets the bot delete group messages < 48h old + with rights.)
  welcomeChatId:    { type: String, default: '' },
  welcomeMessageId: { type: Number, default: null },
}, { timestamps: true });

schema.index({ groupChatId: 1, telegramId: 1 }, { unique: true });
schema.index({ telegramId: 1 });

module.exports = mongoose.model('GroupMember', schema);
