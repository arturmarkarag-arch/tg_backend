const mongoose = require('mongoose');
const baseLinkerAccountScopePlugin = require('./plugins/baseLinkerAccountScope');
const { getBaseLinkerAccountScope } = require('../services/baseLinkerAccount');

const baseLinkerPrintJobSchema = new mongoose.Schema({
  accountScope: { type: String, required: true, default: getBaseLinkerAccountScope, index: true, maxlength: 80 },
  jobId: { type: String, required: true, trim: true, maxlength: 96 },
  orderId: { type: String, default: '', trim: true, maxlength: 64 },
  packageId: { type: Number, required: true, min: 1 },
  courierCode: { type: String, required: true, trim: true, maxlength: 64 },

  requestedByTelegramId: { type: String, required: true, trim: true, maxlength: 64 },
  requestedByName: { type: String, default: '', trim: true, maxlength: 160 },

  targetAgentId: { type: String, required: true, trim: true, maxlength: 96 },
  printerName: { type: String, default: '', trim: true, maxlength: 256 },

  status: {
    type: String,
    enum: ['pending', 'claimed', 'printing', 'succeeded', 'failed', 'expired'],
    default: 'pending',
    index: true,
  },
  attempts: { type: Number, default: 0, min: 0 },
  claimedAt: { type: Date, default: null },
  leaseUntil: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
  lastError: { type: String, default: '', trim: true, maxlength: 1000 },
  labelExtension: { type: String, default: '', trim: true, maxlength: 16 },
}, { timestamps: true });

baseLinkerPrintJobSchema.index({ jobId: 1 }, { unique: true });
baseLinkerPrintJobSchema.index({ accountScope: 1, targetAgentId: 1, status: 1, createdAt: 1 });
baseLinkerPrintJobSchema.index({ accountScope: 1, packageId: 1, status: 1, createdAt: -1 });
baseLinkerPrintJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
baseLinkerPrintJobSchema.plugin(baseLinkerAccountScopePlugin);

module.exports = mongoose.model('BaseLinkerPrintJob', baseLinkerPrintJobSchema);
