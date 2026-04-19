const mongoose = require('mongoose');

const BotInteractionLogSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, index: true },
    type: { type: String, enum: ['inline', 'reply', 'callback'], default: 'callback' },
    action: { type: String, required: true },
    label: { type: String, default: '' },
    context: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

BotInteractionLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 3 });

module.exports = mongoose.model('BotInteractionLog', BotInteractionLogSchema);
