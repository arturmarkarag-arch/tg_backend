const mongoose = require('mongoose');

const OrderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, default: '' },
  price: { type: Number, default: 0 },
  quantity: { type: Number, required: true, min: 1 },
});

const OrderSchema = new mongoose.Schema(
  {
    buyerTelegramId: { type: String, required: true },
    items: { type: [OrderItemSchema], required: true },
    status: { type: String, enum: ['new', 'confirmed', 'fulfilled', 'cancelled'], default: 'new' },
    totalPrice: { type: Number, default: 0 },
    emojiType: { type: String, default: '' },
    shippingAddress: { type: String, default: '' },
    contactInfo: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', OrderSchema);
