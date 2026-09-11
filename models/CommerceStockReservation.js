'use strict';

const mongoose = require('mongoose');

// Provider-neutral hold over CommerceProduct stock. A reservation is created from
// an inbound marketplace order line and never stores buyer/address/payment data.
// `reserved`, `consumed` and `unknown` all count against publishable stock;
// `released` does not. `consumed` intentionally remains held until the future
// physical inventory movement/reconciliation layer confirms that Product.quantity
// already reflects the shipped units.
const CommerceStockReservationSchema = new mongoose.Schema({
  reservationKey: { type: String, required: true, trim: true, maxlength: 128 },
  sourceKind: { type: String, enum: ['marketplace_order'], default: 'marketplace_order', index: true },

  canonicalProvider: { type: String, trim: true, lowercase: true, required: true, maxlength: 40 },
  canonicalOrderId: { type: String, trim: true, required: true, maxlength: 180 },
  canonicalOrderKey: { type: String, trim: true, required: true, maxlength: 260 },
  canonicalLineKey: { type: String, trim: true, required: true, maxlength: 260 },

  sourceProvider: { type: String, trim: true, lowercase: true, required: true, maxlength: 40 },
  sourceAccountId: { type: String, trim: true, default: '', maxlength: 100 },
  sourceOrderId: { type: String, trim: true, default: '', maxlength: 180 },
  sourceLineId: { type: String, trim: true, default: '', maxlength: 180 },
  sourceType: { type: String, trim: true, lowercase: true, default: '', maxlength: 80 },
  sourceExternalOrderId: { type: String, trim: true, default: '', maxlength: 180 },
  sourcePriority: { type: Number, default: 0 },

  auctionId: { type: String, trim: true, default: '', maxlength: 180 },
  sku: { type: String, trim: true, default: '', maxlength: 240 },
  ean: { type: String, trim: true, default: '', maxlength: 120 },
  nameSnapshot: { type: String, trim: true, default: '', maxlength: 600 },

  commerceProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommerceProduct', default: null, index: true },
  channelListingId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChannelListing', default: null },
  matchState: { type: String, enum: ['resolved', 'unresolved', 'ambiguous'], default: 'unresolved', index: true },
  matchStrategy: { type: String, enum: ['listing_offer_id', 'sku', 'ean', 'unresolved', 'ambiguous'], default: 'unresolved' },

  state: { type: String, enum: ['reserved', 'consumed', 'released', 'unknown'], default: 'reserved', index: true },
  quantity: { type: Number, min: 0, default: 0 },
  countsAgainstStock: { type: Boolean, default: true, index: true },
  upstreamDisposition: { type: String, trim: true, lowercase: true, default: '', maxlength: 80 },

  issueCode: { type: String, trim: true, default: '', maxlength: 120 },
  issueMessage: { type: String, trim: true, default: '', maxlength: 1000 },
  sourceObservedAt: { type: Date, default: null },
  firstReservedAt: { type: Date, default: null },
  consumedAt: { type: Date, default: null },
  releasedAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: null },
  lastRefreshId: { type: String, trim: true, default: '', maxlength: 80, index: true },
}, { timestamps: true });

CommerceStockReservationSchema.index({ reservationKey: 1 }, { unique: true });
CommerceStockReservationSchema.index({ commerceProductId: 1, countsAgainstStock: 1, state: 1 });
CommerceStockReservationSchema.index({ canonicalProvider: 1, canonicalOrderId: 1 });
CommerceStockReservationSchema.index({ sourceProvider: 1, sourceAccountId: 1, sourceOrderId: 1 });
CommerceStockReservationSchema.index({ matchState: 1, countsAgainstStock: 1, updatedAt: -1 });

module.exports = mongoose.model('CommerceStockReservation', CommerceStockReservationSchema);
