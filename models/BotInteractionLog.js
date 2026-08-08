const mongoose = require('mongoose');

const BotInteractionLogSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, index: true },
    type: { type: String, enum: ['inline', 'reply', 'callback'], default: 'callback' },
    action: { type: String, required: true },
    label: { type: String, default: '' },
    context: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Без index: true — індекс по createdAt оголошений нижче з TTL. Два оголошення
    // на один ключ дають конфлікт імені createdAt_1, і TTL просто не створюється.
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

BotInteractionLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 3 });

module.exports = mongoose.model('BotInteractionLog', BotInteractionLogSchema);
