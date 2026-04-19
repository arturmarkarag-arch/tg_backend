const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, unique: true },
    role: { type: String, enum: ['seller', 'warehouse', 'admin'], default: 'seller' },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    phoneNumber: { type: String, default: '' },
    shopNumber: { type: String, default: '' },
    shopName: { type: String, default: '' },
    shopAddress: { type: String, default: '' },
    shopCity: { type: String, default: '' },
    warehouseZone: { type: String, default: '' },
    botBlocked: { type: Boolean, default: false },
    botLastActivityAt: { type: Date, default: null },
    botLastSessionAt: { type: Date, default: null },
    lastBotState: {
      shop: {
        productIds: [{ type: String }],
        currentIndex: { type: Number, default: 0 },
        updatedAt: { type: Date, default: null },
      },
      shelf: {
        page: { type: Number, default: 0 },
        updatedAt: { type: Date, default: null },
      },
    },
    miniAppState: {
      lastViewedProductId: { type: String, default: '' },
      currentIndex: { type: Number, default: 0 },
      orderItems: {
        type: Map,
        of: Number,
        default: {},
      },
      updatedAt: { type: Date, default: null },
    },
    isOnline: { type: Boolean, default: false },
    lastActive: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', UserSchema);
