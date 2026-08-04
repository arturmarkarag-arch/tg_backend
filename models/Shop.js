const mongoose = require('mongoose');

const ShopSchema = new mongoose.Schema(
  {
    name:            { type: String, required: true, trim: true },
    cityId:          { type: mongoose.Schema.Types.ObjectId, ref: 'City', default: null },
    deliveryGroupId: { type: String, default: '' },
    address:         { type: String, default: '', trim: true },
    isActive:        { type: Boolean, default: true },
    // Snapshot of the last seller who left this shop (preserved even if the user is deleted)
    lastSeller: {
      telegramId:   { type: String, default: null },
      firstName:    { type: String, default: '' },
      lastName:     { type: String, default: '' },
      unassignedAt: { type: Date, default: null },
    },
    // Timestamp of the last seller assignment or removal for this shop
    lastSellerChangedAt: { type: Date, default: null },
    // NOTE: the shop invite code no longer lives here. It is a RegistrationToken
    // row (telegramId: null, shopId set) so ONE link can either move a registered
    // seller or register a newcomer — see services/registrationToken.js.
  },
  { timestamps: true }
);

ShopSchema.index({ cityId: 1, name: 1 });
ShopSchema.index({ deliveryGroupId: 1 });

module.exports = mongoose.model('Shop', ShopSchema);
