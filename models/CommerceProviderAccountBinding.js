'use strict';

const mongoose = require('mongoose');

const CommerceProviderAccountBindingSchema = new mongoose.Schema({
  provider: { type: String, required: true, trim: true, lowercase: true, maxlength: 60 },
  accountId: { type: String, required: true, trim: true, maxlength: 120 },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', required: true },
  source: { type: String, enum: ['auto_single_entity', 'explicit'], default: 'auto_single_entity' },
}, { timestamps: true });

CommerceProviderAccountBindingSchema.index({ provider: 1, accountId: 1 }, { unique: true });
CommerceProviderAccountBindingSchema.index({ legalEntityId: 1, provider: 1 });

module.exports = mongoose.model('CommerceProviderAccountBinding', CommerceProviderAccountBindingSchema);
