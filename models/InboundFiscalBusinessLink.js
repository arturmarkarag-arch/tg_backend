'use strict';
const mongoose = require('mongoose');

const EvidenceSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, maxlength: 96 },
  weight: { type: Number, required: true, min: -100, max: 100 },
  value: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });
const ActorSchema = new mongoose.Schema({
  id: { type: String, default: '' }, name: { type: String, default: '' }, role: { type: String, default: '' },
}, { _id: false });

const InboundFiscalBusinessLinkSchema = new mongoose.Schema({
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'InboundFiscalDocument', required: true },
  targetType: { type: String, enum: ['business_counterparty', 'receipt'], required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  state: { type: String, enum: ['suggested', 'confirmed', 'rejected'], default: 'suggested', index: true },
  origin: { type: String, enum: ['matcher', 'manual'], default: 'matcher' },
  score: { type: Number, min: 0, max: 100, default: 0 },
  confidence: { type: String, enum: ['exact', 'high', 'medium', 'low', 'manual'], default: 'low' },
  evidence: { type: [EvidenceSchema], default: [] },
  matcherVersion: { type: Number, default: 1 },
  lastEvaluatedAt: { type: Date, default: Date.now },
  decidedAt: { type: Date, default: null },
  decidedBy: { type: ActorSchema, default: null },
  decisionReason: { type: String, default: '', trim: true, maxlength: 1000 },
}, { timestamps: true, optimisticConcurrency: true });

InboundFiscalBusinessLinkSchema.index({ documentId: 1, targetType: 1, targetId: 1 }, { unique: true });
InboundFiscalBusinessLinkSchema.index({ documentId: 1, state: 1, targetType: 1, score: -1 });
InboundFiscalBusinessLinkSchema.index(
  { documentId: 1, targetType: 1 },
  { unique: true, partialFilterExpression: { targetType: 'business_counterparty', state: 'confirmed' } },
);
InboundFiscalBusinessLinkSchema.index({ targetType: 1, targetId: 1, state: 1, createdAt: -1 });
module.exports = mongoose.model('InboundFiscalBusinessLink', InboundFiscalBusinessLinkSchema);
