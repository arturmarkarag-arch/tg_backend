'use strict';

const mongoose = require('mongoose');
const baseLinkerAccountScopePlugin = require('./plugins/baseLinkerAccountScope');
const { getBaseLinkerAccountScope } = require('../services/baseLinkerAccount');

// Dedicated read-through cache for BaseLinker order snapshots.
// This is NOT our business Order model and is never authoritative for fulfilment.
// It only lets the operator UI paginate/search locally without downloading the
// entire BaseLinker account on every page load.
const BaseLinkerOrderCacheSchema = new mongoose.Schema({
  accountScope: { type: String, required: true, default: getBaseLinkerAccountScope, index: true, maxlength: 80 },
  orderId: { type: String, required: true },
  orderIdNumeric: { type: Number, default: 0 },
  orderStatusId: { type: Number, default: null, index: true },
  sortAt: { type: Number, default: 0, index: true },
  statusChangedAt: { type: Number, default: 0, index: true },
  searchText: { type: String, default: '' },
  // Full parsed BaseLinker order snapshot. HTTP/UI projections are derived later.
  order: { type: mongoose.Schema.Types.Mixed, required: true },
  snapshotHash: { type: String, default: '', index: true },
  syncToken: { type: String, default: '', index: true },
  upstreamCachedAt: { type: Date, default: Date.now },
}, { timestamps: true });

BaseLinkerOrderCacheSchema.index({ accountScope: 1, orderId: 1 }, { unique: true });
BaseLinkerOrderCacheSchema.index({ accountScope: 1, orderStatusId: 1, sortAt: -1, orderIdNumeric: -1 });
BaseLinkerOrderCacheSchema.plugin(baseLinkerAccountScopePlugin);

module.exports = mongoose.model('BaseLinkerOrderCache', BaseLinkerOrderCacheSchema);
