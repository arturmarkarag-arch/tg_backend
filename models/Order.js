const mongoose = require('mongoose');

const OrderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, default: '' },
  price: { type: Number, default: 0 },
  quantity: { type: Number, required: true, min: 1 },
  packed: { type: Boolean, default: false },
  cancelled: { type: Boolean, default: false },
});

const BuyerSnapshotSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
  shopName: { type: String, default: '' },
  shopCity: { type: String, default: '' },
  shopAddress: { type: String, default: '' },
  deliveryGroupId: { type: String, default: '' },
}, { _id: false });

const OrderSchema = new mongoose.Schema(
  {
    buyerTelegramId: { type: String, required: true },
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
    items: { type: [OrderItemSchema], required: true },
    status: { type: String, enum: ['new', 'in_progress', 'confirmed', 'fulfilled', 'cancelled', 'expired'], default: 'new' },
    totalPrice: { type: Number, default: 0 },
    orderType: { type: String, enum: ['manual', 'direct_allocation'], default: 'manual' },
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt', default: null },
    emojiType: { type: String, default: '' },
    shippingAddress: { type: String, default: '' },
    contactInfo: { type: String, default: '' },
    idempotencyKey: { type: String },
    orderingSessionId: { type: String, default: '' },
    buyerSnapshot: { type: BuyerSnapshotSchema, default: null },
  },
  { timestamps: true }
);

OrderSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
OrderSchema.index({ orderingSessionId: 1 });

function normalizeOrderItems(items = []) {
  const grouped = new Map();
  for (const item of items) {
    const productId = String(item.productId || '');
    if (!productId) continue;

    const existing = grouped.get(productId);
    if (!existing) {
      grouped.set(productId, {
        productId: item.productId,
        name: item.name || '',
        price: item.price || 0,
        quantity: Number(item.quantity || 0),
        packed: Boolean(item.packed),
        cancelled: Boolean(item.cancelled),
      });
    } else {
      existing.quantity += Number(item.quantity || 0);
      existing.packed = existing.packed || Boolean(item.packed);
      existing.cancelled = existing.cancelled || Boolean(item.cancelled);
    }
  }
  return Array.from(grouped.values());
}

OrderSchema.pre('save', function normalizeItemsOnSave(next) {
  if (!Array.isArray(this.items) || this.items.length < 2) return next();

  const normalizedItems = normalizeOrderItems(this.items);
  if (normalizedItems.length === this.items.length) return next();

  this.items = normalizedItems;
  this.totalPrice = this.items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 0)), 0);
  next();
});

OrderSchema.statics.normalizeItems = normalizeOrderItems;

module.exports = mongoose.model('Order', OrderSchema);
