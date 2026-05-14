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
  },
  { timestamps: true }
);

ShopSchema.index({ cityId: 1, name: 1 });
ShopSchema.index({ deliveryGroupId: 1 });

module.exports = mongoose.model('Shop', ShopSchema);
