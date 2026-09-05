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

const PickingItemSchema = new mongoose.Schema({
  lineKey: { type: String, required: true },
  sourceOrderId: { type: String, default: '' },
  orderProductId: { type: String, default: '' },
  productId: { type: String, default: '' },
  variantId: { type: String, default: '' },
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
  orderId: { type: String, required: true, unique: true },
  // Deterministic logical-order claim identity. Missing on legacy rows until the
  // next claim, so deploying the unique sparse index does not require a risky
  // rewrite of historical documents.
  claimKey: { type: String, default: undefined },
  groupKey: { type: String, default: '' },
  externalOrderId: { type: String, default: '' },
  memberOrderIds: { type: [String], default: [] },
  orderFingerprint: { type: String, default: '' },
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
    default: undefined,
  },
  revision: { type: Number, default: 1 },

  ownerTelegramId: { type: String, default: '' },
  ownerName: { type: String, default: '' },
  claimedAt: { type: Date, default: null },
  lastActivityAt: { type: Date, default: null },

  items: { type: [PickingItemSchema], default: [] },

  packingMode: {
    type: String,
    enum: ['', 'full', 'partial', 'with_issue'],
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
  lastUpstreamChangeSummary: {
    added: { type: Number, default: 0 },
    removed: { type: Number, default: 0 },
    changed: { type: Number, default: 0 },
  },

  history: { type: [PickingHistoryEntrySchema], default: [] },
}, { timestamps: true });

BaseLinkerPickingOrderSchema.index({ status: 1, updatedAt: -1 });
BaseLinkerPickingOrderSchema.index({ workflowStage: 1, updatedAt: -1 });
BaseLinkerPickingOrderSchema.index({ ownerTelegramId: 1, status: 1 });
BaseLinkerPickingOrderSchema.index({ groupKey: 1 });
// Hard DB backstop for two workers/processes claiming the same logical order.
// `sparse` keeps old documents without claimKey deploy-safe; claim writes the
// deterministic key before/while ownership is acquired.
BaseLinkerPickingOrderSchema.index({ claimKey: 1 }, { unique: true, sparse: true });
BaseLinkerPickingOrderSchema.index({ memberOrderIds: 1 });

module.exports = mongoose.model('BaseLinkerPickingOrder', BaseLinkerPickingOrderSchema);
