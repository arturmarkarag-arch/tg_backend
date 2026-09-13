'use strict';

const mongoose = require('mongoose');
const { isValidPolishNip, normalizeTaxId } = require('../services/invoices/taxId');

const AddressSchema = new mongoose.Schema({
  street: { type: String, default: '', trim: true },
  postalCode: { type: String, default: '', trim: true },
  city: { type: String, default: '', trim: true },
  countryCode: { type: String, default: 'PL', trim: true, uppercase: true },
}, { _id: false });

const BankAccountSchema = new mongoose.Schema({
  label: { type: String, default: '', trim: true },
  account: { type: String, default: '', trim: true },
  bankName: { type: String, default: '', trim: true },
  swift: { type: String, default: '', trim: true, uppercase: true },
  isDefault: { type: Boolean, default: false },
}, { _id: false });

const PaymentDefaultsSchema = new mongoose.Schema({
  method: { type: String, default: '', trim: true, lowercase: true },
  dueDays: { type: Number, default: 0, min: 0, max: 3650 },
  bankAccount: { type: String, default: '', trim: true },
}, { _id: false });

const NumberingSchema = new mongoose.Schema({
  invoiceSeries: { type: String, default: 'FV', trim: true },
  correctionSeries: { type: String, default: 'FK', trim: true },
  separator: { type: String, default: '/', trim: true },
  padding: { type: Number, default: 1, min: 1, max: 12 },
}, { _id: false });

const LegalEntitySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  shortName: { type: String, default: '', trim: true },
  countryCode: { type: String, default: 'PL', trim: true, uppercase: true },
  taxIdType: { type: String, default: 'nip', trim: true, lowercase: true },
  taxId: { type: String, required: true, trim: true },
  regon: { type: String, default: '', trim: true },
  krs: { type: String, default: '', trim: true },
  email: { type: String, default: '', trim: true, lowercase: true },
  phone: { type: String, default: '', trim: true },
  address: { type: AddressSchema, default: () => ({}) },
  bankAccounts: { type: [BankAccountSchema], default: [] },
  defaultCurrency: { type: String, default: 'PLN', trim: true, uppercase: true },
  paymentDefaults: { type: PaymentDefaultsSchema, default: () => ({}) },
  numbering: { type: NumberingSchema, default: () => ({}) },
  isActive: { type: Boolean, default: true },
  isDefault: { type: Boolean, default: false },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, optimisticConcurrency: true });

LegalEntitySchema.pre('validate', function validateIdentity(next) {
  try {
    this.countryCode = String(this.countryCode || 'PL').trim().toUpperCase();
    this.taxIdType = String(this.taxIdType || 'nip').trim().toLowerCase();
    this.taxId = normalizeTaxId(this.taxId, { countryCode: this.countryCode, taxIdType: this.taxIdType });
    if (this.countryCode === 'PL' && this.taxIdType === 'nip' && !isValidPolishNip(this.taxId)) {
      const error = new Error('invalid Polish NIP');
      error.code = 'legal_entity_tax_id_invalid';
      return next(error);
    }
    if (!/^[A-Z]{3}$/.test(String(this.defaultCurrency || ''))) {
      const error = new Error('invalid default currency');
      error.code = 'legal_entity_currency_invalid';
      return next(error);
    }
    return next();
  } catch (error) {
    return next(error);
  }
});

LegalEntitySchema.index({ countryCode: 1, taxIdType: 1, taxId: 1 }, { unique: true });
LegalEntitySchema.index({ isActive: 1, name: 1 });
LegalEntitySchema.index(
  { isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);

module.exports = mongoose.model('LegalEntity', LegalEntitySchema);
