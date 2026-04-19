const mongoose = require('mongoose');

const PendingReactionSchema = new mongoose.Schema(
  {
    sellerTelegramId: { type: String, required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    messageId: { type: String, required: true },
    chatId: { type: String, required: true },
    emoji: { type: String, default: '👍' },
    quantity: { type: Number, default: 1 },
  },
  { timestamps: true }
);

PendingReactionSchema.index({ sellerTelegramId: 1, productId: 1 }, { unique: true });

module.exports = mongoose.model('PendingReaction', PendingReactionSchema);
