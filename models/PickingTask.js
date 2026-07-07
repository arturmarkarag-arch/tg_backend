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
        // Stable shop identity — used to resolve the session's box number for this
        // shop (see utils/shopNumbering.js). Two sellers of one shop share a shopId,
        // hence one box number. Older in-flight tasks may lack it → box-number
        // lookup falls back to shopName.
        shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
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
    // Who finalised this task (completed OR marked out-of-stock). `lockedBy` is
    // nulled on completion, so without this the picker's identity is lost — and
    // the shift-board ranking is forced to reconstruct it from Order.history,
    // which credits only whoever packed the LAST item of an order and is not
    // scoped to a session. Stamped once at finalisation in pickingService; the
    // shift board aggregates completed tasks per session by completedBy.
    // Stays null for system-archive completions (archiveProduct closes tasks
    // without a human actor), which the ranking filters out.
    completedBy:     { type: String, default: null },
    completedByName: { type: String, default: '' },
    // Retention: completed tasks are dead weight once their cycle is long over
    // (the shift board reads only the current session, the orphan sweep only the
    // most recent). Stamped = now + 90d at finalisation (real pick OR system
    // archive) so a TTL index reaps them automatically. Stays null for pending/
    // locked tasks, which the TTL ignores (null/missing is never expired).
    completedExpireAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Shift-board ranking: "completed tasks of THIS session, grouped by picker".
PickingTaskSchema.index({ orderingSessionId: 1, status: 1, completedBy: 1 });
// TTL: auto-purge completed tasks 90 days after finalisation. expireAfterSeconds:0
// means "delete once completedExpireAt is in the past"; the date already carries
// the +90d offset. pending/locked tasks have completedExpireAt:null → never reaped.
PickingTaskSchema.index({ completedExpireAt: 1 }, { expireAfterSeconds: 0 });

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
