'use strict';

const mongoose = require('mongoose');
const {
  PERSISTED_ORDER_STATUSES,
  PERSISTED_WORKFLOW_STAGES,
  PERSISTED_ITEM_STATES,
} = require('../domain/warehousePickingState');

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
  auctionId: { type: String, default: '' },
  sku: { type: String, default: '' },
  ean: { type: String, default: '' },
  name: { type: String, default: '' },
  requestedQty: { type: Number, default: 0 },
  sourceFingerprint: { type: String, default: '' },
  state: { type: String, enum: PERSISTED_ITEM_STATES, default: 'pending' },
  pickedQty: { type: Number, default: 0 },
  issueNote: { type: String, default: '' },
  updatedBy: { type: String, default: '' },
  updatedByName: { type: String, default: '' },
  updatedAt: { type: Date, default: null },
}, { _id: false });

const AllegroPickingOrderSchema = new mongoose.Schema({
  allegroAccountId: { type: String, required: true, trim: true, maxlength: 64, index: true },
  allegroAccountNameSnapshot: { type: String, default: '', trim: true, maxlength: 160 },
  orderId: { type: String, required: true, trim: true, maxlength: 128 },
  orderFingerprint: { type: String, default: '' },
  lastUpstreamOrderFingerprint: { type: String, default: '' },
  status: { type: String, enum: PERSISTED_ORDER_STATUSES, default: 'in_progress' },
  workflowStage: { type: String, enum: PERSISTED_WORKFLOW_STAGES, required: true, default: 'processing' },
  revision: { type: Number, default: 1 },
  ownerTelegramId: { type: String, default: '' },
  ownerName: { type: String, default: '' },
  claimedAt: { type: Date, default: null },
  lastActivityAt: { type: Date, default: null },
  items: { type: [PickingItemSchema], default: [] },
  packedAt: { type: Date, default: null },
  packedBy: { type: String, default: '' },
  packedByName: { type: String, default: '' },
  sentAt: { type: Date, default: null },
  sentBy: { type: String, default: '' },
  sentByName: { type: String, default: '' },
  lastUpstreamChangeAt: { type: Date, default: null },
  lastUpstreamVerifiedAt: { type: Date, default: null, index: true },
  lastUpstreamRevision: { type: String, default: '' },
  lastUpstreamOrderStatus: { type: String, default: '' },
  lastUpstreamFulfillmentStatus: { type: String, default: '' },
  upstreamDisposition: {
    type: String,
    enum: ['', 'active', 'suspended', 'sent', 'cancelled', 'returned', 'missing', 'other', 'unverified'],
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

AllegroPickingOrderSchema.index({ allegroAccountId: 1, orderId: 1 }, { unique: true });
AllegroPickingOrderSchema.index({ workflowStage: 1, updatedAt: -1 });
AllegroPickingOrderSchema.index({ ownerTelegramId: 1, status: 1 });
AllegroPickingOrderSchema.index({ upstreamReviewRequired: 1, updatedAt: -1 });
AllegroPickingOrderSchema.index({ sentBy: 1, sentAt: -1 });

module.exports = mongoose.model('AllegroPickingOrder', AllegroPickingOrderSchema);
