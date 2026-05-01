const mongoose = require('mongoose');

const BotSessionSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, index: true },
    type: {
      type: String,
      required: true,
      enum: ['receive', 'shelf', 'ship', 'shop', 'pick'],
      index: true,
    },
    key: { type: String, default: '' },  // extra key (e.g. messageId for ship carousels)
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

// Compound index for fast lookup
BotSessionSchema.index({ chatId: 1, type: 1, key: 1 }, { unique: true });

// TTL index — MongoDB auto-deletes expired documents
BotSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('BotSession', BotSessionSchema);
