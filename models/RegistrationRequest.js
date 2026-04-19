const mongoose = require('mongoose');

const RegistrationRequestSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, index: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    phoneNumber: { type: String, required: true },
    shopCity: { type: String, required: true },
    shopAddress: { type: String, required: true },
    shopName: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

RegistrationRequestSchema.index({ telegramId: 1, status: 1 });

module.exports = mongoose.model('RegistrationRequest', RegistrationRequestSchema);
