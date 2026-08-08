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
  // true = user left/was kicked; false = still member. This is kept for
  // backwards compatibility with the passive tracker; the admin UI should use
  // telegramStatus + statusCheckedAt when it needs a live answer.
  left:         { type: Boolean, default: false },
  // Last status returned by a deliberate getChatMember audit. `unknown` means
  // Telegram could not give us a trustworthy answer (429/403/network/etc.) and
  // MUST NOT be interpreted as absence. Empty string = never live-checked.
  telegramStatus: {
    type: String,
    enum: ['', 'member', 'administrator', 'creator', 'restricted', 'left', 'kicked', 'not_found', 'unknown'],
    default: '',
  },
  statusCheckedAt: { type: Date, default: null },
  statusCheckError: { type: String, default: '' },
  // Soft-hide from the admin Telegram-group monitor. The row is historical and
  // is never deleted. The admin "Видалити" action also soft-removes an existing
  // User account; successful re-registration clears these fields automatically.
  // Passive Telegram events keep updating the row but never unhide it by themselves.
  hiddenAt: { type: Date, default: null },
  hiddenByTelegramId: { type: String, default: '' },
  // The group welcome ("register here") message we posted for this member, so we
  // can delete it once they register. message_id null = none outstanding.
  // (Telegram only lets the bot delete group messages < 48h old + with rights.)
  welcomeChatId:    { type: String, default: '' },
  welcomeMessageId: { type: Number, default: null },
}, { timestamps: true });

schema.index({ groupChatId: 1, telegramId: 1 }, { unique: true });
schema.index({ telegramId: 1 });

module.exports = mongoose.model('GroupMember', schema);
