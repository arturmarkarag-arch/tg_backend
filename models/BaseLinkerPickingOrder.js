const {
  PERSISTED_ORDER_STATUSES,
  PERSISTED_WORKFLOW_STAGES,
  PERSISTED_ITEM_STATES,
} = require('../domain/baseLinkerPickingState');
const mongoose = require('mongoose');

const PickingHistoryEntrySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: { type: String, default: '' },
  byName: { type: String, default: '' },
  byRole: { type: String, default: '' },
  action: { type: String, required: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const UpstreamChangeDetailSchema = new mongoose.Schema({
  kind: { type: String, enum: ['added', 'removed', 'changed'], required: true },
  lineKey: { type: String, default: '' },
  name: { type: String, default: '' },
  field: { type: String, default: '' },
  fromValue: { type: String, default: '' },
  toValue: { type: String, default: '' },
  qty: { type: Number, default: 0 },
}, { _id: false });

const PickingItemSchema = new mongoose.Schema({
  lineKey: { type: String, required: true },
  sourceOrderId: { type: String, default: '' },
  orderProductId: { type: String, default: '' },
  storage: { type: String, default: '' },
  storageId: { type: String, default: '' },
  productId: { type: String, default: '' },
  variantId: { type: String, default: '' },
  auctionId: { type: String, default: '' },
  sku: { type: String, default: '' },
  ean: { type: String, default: '' },
  name: { type: String, default: '' },
  attributes: { type: String, default: '' },
  requestedQty: { type: Number, default: 0 },
  sourceFingerprint: { type: String, default: '' },

  state: {
    type: String,
    enum: PERSISTED_ITEM_STATES,
    default: 'pending',
  },
  pickedQty: { type: Number, default: 0 },
  issueNote: { type: String, default: '' },

  updatedBy: { type: String, default: '' },
  updatedByName: { type: String, default: '' },
  updatedAt: { type: Date, default: null },
}, { _id: false });

const BaseLinkerPickingOrderSchema = new mongoose.Schema({
  baseLinkerAccountId: { type: String, required: true, trim: true, maxlength: 64, index: true },
  // Human labels are snapshots only; accountId/source IDs remain identity.
  baseLinkerAccountNameSnapshot: { type: String, default: '', trim: true, maxlength: 160 },
  orderId: { type: String, required: true },
  orderFingerprint: { type: String, default: '' },
  // Last exact BaseLinker product fingerprint. After Packed/Sent, orderFingerprint/items remain the immutable warehouse snapshot while this field tracks later upstream changes.
  lastUpstreamOrderFingerprint: { type: String, default: '' },
  // Minimal source metadata needed to render our own local workflow after the
  // order leaves Intake. This is not a BaseLinker order mirror.
  sourceShopOrderId: { type: String, default: '' },
  sourceExternalOrderId: { type: String, default: '' },
  sourceType: { type: String, default: '', trim: true, lowercase: true, maxlength: 80 },
  sourceId: { type: String, default: '', trim: true, maxlength: 120 },
  sourceNameSnapshot: { type: String, default: '', trim: true, maxlength: 240 },
  sourceNameLastKnown: { type: String, default: '', trim: true, maxlength: 240 },
  sourceResolvedAt: { type: Date, default: null },
  sourceDateAdd: { type: Number, default: 0 },
  sourceDateConfirmed: { type: Number, default: 0 },
  sourceDeliveryPackageModule: { type: String, default: '' },
  sourceDeliveryPackageNr: { type: String, default: '' },
  status: {
    type: String,
    enum: PERSISTED_ORDER_STATUSES,
    default: 'in_progress',
  },
  // Operational shelf is deliberately independent from detailed picking
  // status and ownership. Claiming a deferred order must not move it back to
  // Processing merely because somebody started working on it again.
  workflowStage: {
    type: String,
    enum: PERSISTED_WORKFLOW_STAGES,
    required: true,
    default: 'processing',
  },
  revision: { type: Number, default: 1 },

  ownerTelegramId: { type: String, default: '' },
  ownerName: { type: String, default: '' },
  claimedAt: { type: Date, default: null },
  lastActivityAt: { type: Date, default: null },

  items: { type: [PickingItemSchema], default: [] },

  packingMode: {
    type: String,
    enum: ['', 'full'],
    default: '',
  },
  packedSummary: {
    requestedQty: { type: Number, default: 0 },
    packedQty: { type: Number, default: 0 },
    missingQty: { type: Number, default: 0 },
    problemLines: { type: Number, default: 0 },
  },

  packedAt: { type: Date, default: null },
  packedBy: { type: String, default: '' },
  packedByName: { type: String, default: '' },
  sentAt: { type: Date, default: null },
  sentBy: { type: String, default: '' },
  sentByName: { type: String, default: '' },

  lastUpstreamChangeAt: { type: Date, default: null },
  lastUpstreamVerifiedAt: { type: Date, default: null, index: true },
  lastUpstreamStatusId: { type: Number, default: null },
  upstreamDisposition: {
    type: String,
    enum: ['', 'intake', 'sent', 'cancelled', 'other', 'missing', 'unverified'],
    default: '',
    index: true,
  },
  upstreamReviewRequired: { type: Boolean, default: false, index: true },
  upstreamReviewedAt: { type: Date, default: null },
  lastUpstreamChangeSummary: {
    added: { type: Number, default: 0 },
    removed: { type: Number, default: 0 },
    changed: { type: Number, default: 0 },
  },
  lastUpstreamChangeDetails: { type: [UpstreamChangeDetailSchema], default: [] },

  history: { type: [PickingHistoryEntrySchema], default: [] },
}, { timestamps: true, optimisticConcurrency: true });

BaseLinkerPickingOrderSchema.index({ baseLinkerAccountId: 1, orderId: 1 }, { unique: true });
BaseLinkerPickingOrderSchema.index({ status: 1, updatedAt: -1 });
BaseLinkerPickingOrderSchema.index({ workflowStage: 1, updatedAt: -1 });
BaseLinkerPickingOrderSchema.index({ workflowStage: 1, packedBy: 1, packedAt: -1 });
BaseLinkerPickingOrderSchema.index({ ownerTelegramId: 1, status: 1 });
// The composite unique account+order index above is the DB backstop for claim races.
BaseLinkerPickingOrderSchema.index({ upstreamReviewRequired: 1, updatedAt: -1 });
BaseLinkerPickingOrderSchema.index({ upstreamDisposition: 1, lastUpstreamChangeAt: 1 });
BaseLinkerPickingOrderSchema.index({ status: 1, sentAt: 1 });


module.exports = mongoose.model('BaseLinkerPickingOrder', BaseLinkerPickingOrderSchema);
