'use strict';

const mongoose = require('mongoose');

const CommerceStockReservationStateSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true, default: 'marketplace', unique: true },
  // Epoch prevents the first deployment from backfilling all historical shipped
  // orders as "consumed" against today's Product.quantity. Existing open orders
  // are reserved immediately; terminal orders are only auto-materialized when
  // they happened after this ledger started.
  startedAt: { type: Date, required: true, default: Date.now },
  lastRefreshAt: { type: Date, default: null },
  lastRefreshId: { type: String, trim: true, default: '' },
  lastError: { type: String, trim: true, default: '' },
  lastSummary: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { timestamps: true });

module.exports = mongoose.model('CommerceStockReservationState', CommerceStockReservationStateSchema);
