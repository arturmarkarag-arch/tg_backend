'use strict';

const mongoose = require('mongoose');

// Local, worker-safe projection of Allegro orders. Deliberately does NOT mirror
// buyer/address/payment/invoice data or raw Allegro JSON. Upstream Allegro remains
// authoritative; this collection exists for zero-upstream list/search/pagination.
const AllegroOrderIndexSchema = new mongoose.Schema({
  accountId: { type: String, required: true, trim: true, maxlength: 64, index: true },
  checkoutFormId: { type: String, required: true, trim: true, maxlength: 128 },
  revision: { type: String, default: '', trim: true, maxlength: 128 },
  orderStatus: { type: String, default: '', trim: true, maxlength: 80, index: true },
  fulfillmentStatus: { type: String, default: '', trim: true, maxlength: 80, index: true },
  fulfillmentProviderId: { type: String, default: '', trim: true, maxlength: 80, index: true },
  marketplaceId: { type: String, default: '', trim: true, maxlength: 80, index: true },
  // Upstream Allegro state and our local warehouse shelf are deliberately separate.
  upstreamStage: {
    type: String,
    enum: ['processing', 'deferred', 'sent', 'cancelled'],
    default: 'processing',
    index: true,
  },
  workflowStage: {
    type: String,
    enum: ['processing', 'deferred', 'sent', 'cancelled'],
    default: 'processing',
    index: true,
  },
  upstreamReviewRequired: { type: Boolean, default: false, index: true },
  warehouseStatus: { type: String, default: '', trim: true, maxlength: 80, index: true },
  sentBy: { type: String, default: '', trim: true, maxlength: 128, index: true },
  sentByName: { type: String, default: '', trim: true, maxlength: 240 },
  orderSortDate: { type: Date, default: null, index: true },
  upstreamUpdatedAt: { type: Date, default: null },
  lastEventId: { type: String, default: '', trim: true, maxlength: 128 },
  lastEventType: { type: String, default: '', trim: true, maxlength: 80 },
  lastEventOccurredAt: { type: Date, default: null },
  preview: { type: mongoose.Schema.Types.Mixed, required: true },
  searchText: { type: String, default: '', maxlength: 8192 },
  seenAt: { type: Date, default: Date.now },
}, { timestamps: true });

AllegroOrderIndexSchema.index({ accountId: 1, checkoutFormId: 1 }, { unique: true });
AllegroOrderIndexSchema.index({ workflowStage: 1, orderSortDate: -1, checkoutFormId: 1 });
AllegroOrderIndexSchema.index({ accountId: 1, workflowStage: 1, orderSortDate: -1, checkoutFormId: 1 });

module.exports = mongoose.model('AllegroOrderIndex', AllegroOrderIndexSchema);
