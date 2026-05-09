const mongoose = require('mongoose');

const ShopSchema = new mongoose.Schema(
  {
    name:            { type: String, required: true, trim: true },
    cityId:          { type: mongoose.Schema.Types.ObjectId, ref: 'City', default: null },
    city:            { type: String, default: '', trim: true }, // legacy / denorm cache
    deliveryGroupId: { type: String, default: '' },
    address:         { type: String, default: '', trim: true },
    isActive:        { type: Boolean, default: true },
    cartState: {
      orderItems:          { type: Map, of: Number, default: {} },
      orderItemIds:        { type: [String], default: [] },
      lastOrderPositions:  { type: Number, default: 0 },
      lastViewedProductId: { type: String, default: '' },
      currentIndex:        { type: Number, default: 0 },
      currentPage:         { type: Number, default: 0 },
      updatedAt:           { type: Date, default: null },
    },
  },
  { timestamps: true }
);

ShopSchema.index({ cityId: 1, name: 1 });
ShopSchema.index({ city: 1, name: 1 });
ShopSchema.index({ deliveryGroupId: 1 });

module.exports = mongoose.model('Shop', ShopSchema);
