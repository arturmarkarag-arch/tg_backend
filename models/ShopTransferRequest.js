'use strict';
const mongoose = require('mongoose');

// Snapshot of conflict state captured at request creation time
const ConflictSnapshotSchema = new mongoose.Schema({
  // Target shop seller snapshot (informational; multi-seller shops are valid)
  targetShopHasSeller: { type: Boolean, default: false },
  targetShopSellerName: { type: String, default: '' },
  targetShopSellerTelegramId: { type: String, default: '' },
  // First existing target seller's state (legacy snapshot fields; informational only)
  targetSellerHasActiveOrder: { type: Boolean, default: false },
  targetSellerActiveOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  // Requesting seller's current shop active order. It may follow the seller only
  // while ordering is still open; after freeze it remains owned by the old shop.
  sourceShopHasActiveOrder: { type: Boolean, default: false },
  sourceShopActiveOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  // Admin(s) assigned to the target shop at submission time (display only — they are NOT displaced)
  targetShopAdminNames: { type: [String], default: [] },
  // Full target-shop picture at submission time (display/audit only — guards recompute fresh)
  targetShopSellerCount: { type: Number, default: 0 },
  targetShopActiveOrderCount: { type: Number, default: 0 },
  targetShopDistinctBuyerCount: { type: Number, default: 0 },
  targetShopHasConflict: { type: Boolean, default: false },
}, { _id: false });

const ShopTransferRequestSchema = new mongoose.Schema({
  // Who is requesting
  sellerTelegramId: { type: String, required: true, index: true },
  sellerName: { type: String, default: '' },
  isAssignment: { type: Boolean, default: false },   // true = first-time assignment
  isProfileOnly: { type: Boolean, default: false },  // true = only profile data update, no shop change

  // From which shop (null when seller has no shop yet — initial assignment request)
  fromShopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
  fromShopName: { type: String, default: '' },
  fromDeliveryGroupId: { type: String, default: '' },

  // To which shop (null for profile-only requests)
  toShopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
  toShopName: { type: String, default: '' },
  toDeliveryGroupId: { type: String, default: '' },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending',
    index: true,
  },

  // Conflict state at submission time (so admin sees what was true when seller asked)
  conflictSnapshot: { type: ConflictSnapshotSchema, default: () => ({}) },

  // Admin decision
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: String, default: null }, // admin telegramId
  resolvedByName: { type: String, default: '' },
  rejectReason: { type: String, default: '' },

  // Optional profile data update requested by the seller
  profileUpdate: {
    firstName:   { type: String, default: '' },
    lastName:    { type: String, default: '' },
    phoneNumber: { type: String, default: '' },
  },
}, { timestamps: true });

// One pending request per seller at a time
ShopTransferRequestSchema.index(
  { sellerTelegramId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);

module.exports = mongoose.model('ShopTransferRequest', ShopTransferRequestSchema);
