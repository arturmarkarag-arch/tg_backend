const mongoose = require('mongoose');

const PhotoCommentSchema = new mongoose.Schema(
  {
    id: { type: String, default: '' },
    text: { type: String, default: '' },
    pos: {
      x: { type: Number, default: 0.5 },
      y: { type: Number, default: 0.5 },
    },
  },
  { _id: false },
);


const TelegramNewProductSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['not_sent', 'queued', 'sending', 'retry_wait', 'sent', 'failed', 'unknown', 'missing', 'expired'],
      default: 'not_sent',
    },
    chatId: { type: String, default: '' },
    messageId: { type: Number, default: null },
    telegramPhotoFileId: { type: String, default: '' },

    // Canonical Telegram payload. Only user-visible publication data belongs in
    // the hash/snapshots; canvas label positions intentionally do not.
    desiredHash: { type: String, default: '' },
    desiredSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    desiredCaption: { type: String, default: '' },
    appliedHash: { type: String, default: '' },
    appliedSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    appliedCaption: { type: String, default: '' },

    requestedAt: { type: Date, default: null },
    requestedBy: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    editedAt: { type: Date, default: null },
    missingAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    possibleDuplicate: { type: Boolean, default: false },
    lastError: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

    // Remember the worker's answer for the exact canonical payload. This stops a
    // visual-only re-save (moving price/comment labels) from asking again.
    lastDecision: { type: String, enum: ['', 'publish', 'skip'], default: '' },
    lastDecisionHash: { type: String, default: '' },
    lastDecisionAt: { type: Date, default: null },
    lastDecisionBy: { type: String, default: '' },
  },
  { _id: false },
);

const ReceiptItemSchema = new mongoose.Schema(
  {
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt', required: true },

    // Immutable provenance only: who physically accepted the row. It is NOT an
    // edit lock; every warehouse/admin user may edit. Delete policy stays separate.
    createdBy: { type: String, default: '' },

    // Optimistic-concurrency clocks. Legacy rows read as revision 0.
    // editRevision protects receiving/commercial/photo metadata; routingRevision
    // protects route choices independently so cosmetic edits never block routing.
    editRevision: { type: Number, default: 0, min: 0 },
    routingRevision: { type: Number, default: 0, min: 0 },

    // Per-item publication confirmation. In the current staged regular flow the
    // receiving Receipt may be completed before this happens; confirmation later
    // publishes the prepared/routed product. Legacy receipt flows may still gate
    // whole-receipt commit on item confirmation.
    status: { type: String, enum: ['draft', 'confirmed'], default: 'draft' },

    // Legacy/idempotency marker for derived Product/ShopProduct application.
    // For routingVersion >= 1, totalQty is receiving/reference data and MUST NOT
    // be interpreted as the remaining warehouse quantity.
    stockApplied: { type: Boolean, default: false },

    // Legacy compatibility only. New business logic lives in `routing` below.
    // Keep this field so old receipts and the existing rollback/sync machinery can
    // still understand historical rows without a destructive migration.
    destination: { type: String, enum: ['shelf', 'shops'], default: 'shelf' },

    // Real per-item routing. The current pipeline is staged:
    // receiving (photo; totalQty is optional metadata for modern rows) -> preparation
    // (price + qtyPerPackage) -> routing. A new item can sit with every flag=false until Stage 2 is ready.
    // `warehouse` may combine with mandatory OR supplement;
    // mandatory+supplement is forbidden by the route validator.
    routingVersion: { type: Number, default: 0 },
    routing: {
      warehouse: { type: Boolean, default: false },
      mandatory: { type: Boolean, default: false },
      supplement: { type: Boolean, default: false },
      mayNotReachAllShops: { type: Boolean, default: false },
      supplementDeliveryGroupId: { type: String, default: null },
    },

    // Supplement publication is intentionally separate from per-item preparation.
    // Workers may prepare/confirm 100 supplement goods first, then choose ONE
    // delivery group while publishing the whole batch with ONE notification.
    // Version 0 = legacy auto-open behaviour. Version 1 = older batch flow where
    // the group was stored per item. Version 2 = current flow: the item may stay
    // unassigned until batch publication atomically sets the group for the batch.
    // `supplementPublishRequestedAt` is compatibility/audit only: first successful
    // publication time. READY/OPEN/FROZEN/COMPLETED eligibility is derived from
    // all modern SupplementOffer rows of this ReceiptItem, never one target alone.
    supplementBatchVersion: { type: Number, default: 0 },
    supplementPublishRequestedAt: { type: Date, default: null },

    // Routing-correction audit compatibility. The full timeline stays in
    // ReceiptItemLog. `alreadyFulfilledShopIds` is retained for old documents/API
    // shape only; current supplement cancellation annuls the whole revision and
    // writes this list empty.
    routingCorrection: {
      correctedAt: { type: Date, default: null },
      correctedBy: { type: String, default: '' },
      reason: { type: String, default: '' },
      alreadyFulfilledShopIds: { type: [String], default: [] },
      sourceWaveIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    },

    photoUrl: { type: String, default: '' },
    photoName: { type: String, default: '' },
    // Clean, un-annotated capture. Kept so that editing price/qty later can
    // re-render the overlay from scratch instead of stacking labels.
    originalPhotoUrl: { type: String, default: '' },
    photoMeta: {
      comment: { type: String, default: '' },
      commentPos: {
        x: { type: Number, default: 0.5 },
        y: { type: Number, default: 0.5 },
      },
      // V47.14: multiple independently positioned photo comments. The legacy
      // comment/commentPos pair above mirrors the first row for old clients.
      comments: { type: [PhotoCommentSchema], default: [] },
      pricePos: { type: mongoose.Schema.Types.Mixed, default: null },
      qtyPos:   { type: mongoose.Schema.Types.Mixed, default: null },
    },

    // Optional receiving/reference quantity for the modern routing flow. `null`
    // means the worker has not entered it yet; zero is never a valid received
    // quantity. For routingVersion < 1 legacy rows the server still requires this
    // field and preserves the historical stock-delta behaviour.
    totalQty: {
      type: Number,
      default: null,
      validate: {
        validator: (value) => value == null || (Number.isInteger(value) && value >= 1),
        message: 'totalQty must be a positive integer',
      },
    },

    // Stable position inside an automatically-created bulk intake. These fields
    // are audit/idempotency metadata only and never identify the business Product.
    intakeClientItemId: { type: String, default: null },
    intakeIndex: { type: Number, default: null, min: 0 },

    // LEGACY direct-to-shops allocation fields. Current UI does not collect or
    // use them: mandatory distribution is a manual warehouse decision and the
    // Historical per-item group data may remain for compatibility, but current
    // regular receipts select the supplement delivery group at batch publish time.
    deliveryGroupIds: [{ type: String }],
    qtyPerShop: { type: Number, default: 0 },

    // Internal/background identity generated from the photo. There is no manual
    // "Назва товару" field in the receipt form; AI may populate this later.
    name: { type: String, default: '' },
    aiDescription: { type: String, default: '' },

    // Stage 2 (commercial preparation). Intentionally empty after physical
    // receiving; both fields are mandatory before Stage 3 routing.
    price: { type: Number, default: null },
    qtyPerPackage: { type: Number, default: null },

    // Product created by this receipt item.
    createdProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    // For mandatory-only items (and legacy destination='shops' rows): the
    // shop-owned ShopProduct created with linkedProductId:null. Tracked for
    // idempotency + unconfirm/rollback compatibility.
    createdShopProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShopProduct', default: null },


    // LEGACY migration snapshot only. Runtime Telegram lifecycle state moved to
    // TelegramPublication + TelegramPublicationBinding + TelegramPublicationEvent.
    // Keep the embedded document so historical rows can be migrated safely; new
    // code must not use it as the source of truth.
    telegramNewProduct: { type: TelegramNewProductSchema, default: () => ({}) },
  },
  { timestamps: true }
);

// Durable idempotency for one client file inside one bulk-intake receipt.
ReceiptItemSchema.index(
  { receiptId: 1, intakeClientItemId: 1 },
  { unique: true, partialFilterExpression: { intakeClientItemId: { $type: 'string' } } },
);

module.exports = mongoose.model('ReceiptItem', ReceiptItemSchema);
