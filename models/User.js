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
    isOnline: { type: Boolean, default: false },
    lastActive: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', UserSchema);
