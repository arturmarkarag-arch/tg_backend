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
        // First+last name of the buyer (seller) who created this order — shown as a
        // faint subtitle under the shop name in the packing card.
        sellerName: { type: String, default: '' },
        // Order.createdAt at build time — the picking/packing list is sorted by this
        // (oldest order first) so a shop's position never depends on when THIS
        // product was added, only on when the order itself was first created.
        orderCreatedAt: { type: Date, default: null },
        quantity: { type: Number, default: 0 },
        packedQuantity: { type: Number, default: null },
        packed: { type: Boolean, default: false },
      },
    ],
    // A completed out-of-stock task (status:'completed' with an item packed:false) is
    // the orphan-archive sweep's standing signal to (re)archive the product
    // (services/pickingService.archiveOrphanedOutOfStockProducts). Product
    // restore-from-archive (routes/archive.js) sets this true to CONSUME that signal:
    // restore deliberately un-archives the product, so its old OOS task must stop
    // re-triggering the sweep — otherwise the next next-task/start-session poll
    // re-archives the just-restored product. The sweep filters archiveReconciled:{$ne:true}.
    archiveReconciled: { type: Boolean, default: false },
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
