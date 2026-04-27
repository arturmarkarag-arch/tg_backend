const mongoose = require('mongoose');

// WARNING: SearchProduct is a separate scheme for store-specific items only.
// It must never be merged with warehouse Product inventory or stock management.
const SearchProductSchema = new mongoose.Schema(
  {
    barcode: { type: String, default: '' },
    price: { type: Number, default: 0 },
    title: { type: String, default: '' },
    caption: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    imageName: { type: String, default: '' },
    telegramPhotoFileId: { type: String, default: '' },
    telegramMessageId: { type: String, default: '' },
    requestTelegramPhotoFileId: { type: String, default: '' },
    requestTelegramMessageId: { type: String, default: '' },
    requestCaption: { type: String, default: '' },
    groupChatId: { type: String, default: '' },
    adminTelegramId: { type: String, default: '' },
    adminName: { type: String, default: '' },
    source: { type: String, default: 'group_search' },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  },
  { timestamps: true }
);

SearchProductSchema.index({ barcode: 1 });
SearchProductSchema.index({ groupChatId: 1 });
SearchProductSchema.index({ price: 1 });
SearchProductSchema.index({ barcode: 1, groupChatId: 1 }, { unique: true });

module.exports = mongoose.model('SearchProduct', SearchProductSchema);
