const mongoose = require('mongoose');

const ReactionDetailSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  reactionType: { type: String, required: true },
  quantity: { type: Number, default: 1 },
  createdAt: { type: Date, default: Date.now },
});

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    price: { type: Number, required: true, default: 0 },
    quantity: { type: Number, required: true, default: 0 },
    warehouse: { type: String, default: '' },
    category: { type: String, default: '' },
    brand: { type: String, default: '' },
    model: { type: String, default: '' },
    deliveryGroup: { type: String, default: '' },
    orderNumber: { type: Number, required: true, default: 1 },
    status: { type: String, enum: ['pending', 'active', 'archived'], default: 'pending' },
    positionOrder: { type: Number, default: 0 },
    localImageUrl: { type: String, default: '' },
    imageUrls: [{ type: String, default: [] }],
    imageNames: [{ type: String, default: [] }],
    telegramFileId: { type: String, default: '' },
    telegramMessageId: { type: String, default: '' },
    telegramMessageIds: [{ type: String }],
    storeLinks: [{ type: String }],
    quantityPerPackage: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
    originalOrderNumber: { type: Number, default: null },
    totalReserved: { type: Number, default: 0 },
    reactions: { type: Map, of: Number, default: {} },
    reactionDetails: [ReactionDetailSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Product', ProductSchema);
