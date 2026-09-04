const mongoose = require('mongoose');

const baseLinkerPrintAgentSchema = new mongoose.Schema({
  agentId: { type: String, required: true, trim: true, maxlength: 96 },
  printerName: { type: String, default: '', trim: true, maxlength: 256 },
  version: { type: String, default: '', trim: true, maxlength: 64 },
  capabilities: { type: [String], default: [] },
  lastSeenAt: { type: Date, required: true, default: Date.now },
  lastIp: { type: String, default: '', trim: true, maxlength: 128 },
}, { timestamps: true });

baseLinkerPrintAgentSchema.index({ agentId: 1 }, { unique: true });
baseLinkerPrintAgentSchema.index({ lastSeenAt: -1 });
baseLinkerPrintAgentSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('BaseLinkerPrintAgent', baseLinkerPrintAgentSchema);
