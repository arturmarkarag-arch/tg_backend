const mongoose = require('mongoose');

const RegistrationRequestSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, index: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    phoneNumber: { type: String, default: '' },
    shopId: { type: String, default: null },
    // shopName/shopCity were dropped — always resolved at read time via Shop.findById(shopId)
    // so renaming a shop does not leave stale strings on pending requests.
    deliveryGroupId: { type: String, default: '' },
    role: { type: String, enum: ['seller', 'warehouse'], default: 'seller' },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'blocked'], default: 'pending' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

RegistrationRequestSchema.index({ telegramId: 1, status: 1 });

module.exports = mongoose.model('RegistrationRequest', RegistrationRequestSchema);