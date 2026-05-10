const mongoose = require('mongoose');

const PickingTaskSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    deliveryGroupId: { type: String, default: '' },
    blockId: { type: Number, required: true },
    positionIndex: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'locked', 'completed'], default: 'pending' },
    lockedBy: { type: String, default: null },
    lockedAt: { type: Date, default: null },
    items: [
      {
        orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
        shopName: { type: String, default: '' },
        quantity: { type: Number, default: 0 },
        packedQuantity: { type: Number, default: null },
        packed: { type: Boolean, default: false },
      },
    ],
  },
  { timestamps: true }
);

PickingTaskSchema.index({ status: 1, blockId: 1, positionIndex: 1 });
PickingTaskSchema.index({ productId: 1, blockId: 1 });

// One active (pending/locked) task per (product, deliveryGroup) at a time.
PickingTaskSchema.index(
  { productId: 1, deliveryGroupId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'locked'] } } }
);

module.exports = mongoose.model('PickingTask', PickingTaskSchema);
