const mongoose = require('mongoose');

const PickingTaskSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    deliveryGroupId: { type: String, default: '' },
    // OrderingSession._id (string) this task belongs to. Stamped at build time so
    // ALL picking detection (confirmed / in-progress / all-collected) is scoped to
    // a concrete session by membership, never by a `updatedAt >= sessionOpenAt`
    // time window — which is what let a previous cycle's completions leak into a
    // new session when the admin changed the delivery day.
    orderingSessionId: { type: String, default: null },
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
// Session-scoped lookups: "active/completed tasks of THIS ordering session".
PickingTaskSchema.index({ orderingSessionId: 1, status: 1 });

// One active (pending/locked) task per (product, deliveryGroup) at a time.
PickingTaskSchema.index(
  { productId: 1, deliveryGroupId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'locked'] } } }
);

module.exports = mongoose.model('PickingTask', PickingTaskSchema);
