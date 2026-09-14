'use strict';
const mongoose = require('mongoose');
const { normalizeTaxId } = require('../services/invoices/inboundLinkingPolicy');

const BusinessCounterpartySchema = new mongoose.Schema({
  legalName: { type: String, required: true, trim: true, maxlength: 512 },
  normalizedName: { type: String, required: true, trim: true, maxlength: 512 },
  aliases: { type: [String], default: [] },
  roles: { type: [String], enum: ['supplier', 'customer'], default: ['supplier'] },
  countryCode: { type: String, default: 'PL', trim: true, uppercase: true, maxlength: 8 },
  taxIdType: { type: String, default: 'nip', trim: true, lowercase: true, maxlength: 32 },
  taxId: { type: String, default: '', trim: true, maxlength: 64 },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, optimisticConcurrency: true });

BusinessCounterpartySchema.pre('validate', function normalizeIdentity(next) {
  try {
    this.countryCode = String(this.countryCode || 'PL').trim().toUpperCase();
    this.taxIdType = String(this.taxIdType || '').trim().toLowerCase();
    this.taxId = normalizeTaxId(this.taxId);
    this.normalizedName = String(this.normalizedName || this.legalName || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^0-9A-ZĄĆĘŁŃÓŚŹŻ]+/g, ' ').replace(/\s+/g, ' ').trim();
    next();
  } catch (error) { next(error); }
});
BusinessCounterpartySchema.index({ countryCode: 1, taxIdType: 1, taxId: 1 }, { unique: true, partialFilterExpression: { taxId: { $gt: '' } } });
BusinessCounterpartySchema.index({ normalizedName: 1, status: 1 });
BusinessCounterpartySchema.index({ roles: 1, status: 1, legalName: 1 });
module.exports = mongoose.model('BusinessCounterparty', BusinessCounterpartySchema);
