'use strict';

const mongoose = require('mongoose');
const { INVOICE_CORE_VERSION, INVOICE_STATUSES, INVOICE_TYPES, PRICE_BASIS } = require('../services/invoices/contract');

const AddressSchema = new mongoose.Schema({
  street: { type: String, default: '' },
  postalCode: { type: String, default: '' },
  city: { type: String, default: '' },
  countryCode: { type: String, default: '' },
}, { _id: false });

const PartySchema = new mongoose.Schema({
  legalEntityId: { type: String, default: '' },
  name: { type: String, default: '' },
  taxId: { type: String, default: '' },
  taxIdType: { type: String, default: '' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  address: { type: AddressSchema, default: () => ({}) },
}, { _id: false });

const ActorSchema = new mongoose.Schema({
  id: { type: String, default: '' },
  name: { type: String, default: '' },
  role: { type: String, default: '' },
}, { _id: false });

const SourceSchema = new mongoose.Schema({
  provider: { type: String, required: true, trim: true },
  entityType: { type: String, required: true, trim: true },
  entityId: { type: String, required: true, trim: true },
  externalNumber: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const VatSchema = new mongoose.Schema({
  code: { type: String, default: '' },
  rate: { type: String, default: '' },
}, { _id: false });

const AmountSchema = new mongoose.Schema({
  net: { type: String, default: '' },
  vat: { type: String, default: '' },
  gross: { type: String, default: '' },
}, { _id: false });

const InvoiceItemSchema = new mongoose.Schema({
  sourceLineId: { type: String, default: '' },
  productRef: { type: String, default: '' },
  name: { type: String, default: '' },
  quantity: { type: String, default: '' },
  unit: { type: String, default: 'szt.' },
  unitPrice: { type: String, default: '' },
  priceBasis: { type: String, enum: Object.values(PRICE_BASIS), default: PRICE_BASIS.UNKNOWN },
  vat: { type: VatSchema, default: () => ({}) },
  amounts: { type: AmountSchema, default: () => ({}) },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const PaymentSchema = new mongoose.Schema({
  method: { type: String, default: '' },
  dueDate: { type: String, default: '' },
  bankAccount: { type: String, default: '' },
  paid: { type: Boolean, default: false },
  paidAt: { type: String, default: '' },
}, { _id: false });

const InvoiceSchema = new mongoose.Schema({
  coreVersion: { type: Number, default: INVOICE_CORE_VERSION, immutable: true },
  type: { type: String, enum: Object.values(INVOICE_TYPES), default: INVOICE_TYPES.INVOICE },
  status: { type: String, enum: Object.values(INVOICE_STATUSES), default: INVOICE_STATUSES.DRAFT },
  source: { type: SourceSchema, required: true },
  seller: { type: PartySchema, default: () => ({}) },
  buyer: { type: PartySchema, default: () => ({}) },
  recipient: { type: PartySchema, default: null },
  issueDate: { type: String, default: '' },
  saleDate: { type: String, default: '' },
  currency: { type: String, default: 'PLN' },
  items: { type: [InvoiceItemSchema], default: [] },
  totals: { type: AmountSchema, default: () => ({}) },
  payment: { type: PaymentSchema, default: () => ({}) },
  references: { type: mongoose.Schema.Types.Mixed, default: {} },
  notes: { type: String, default: '' },
  idempotencyKey: { type: String, default: '' },
  finalizedSnapshotId: { type: mongoose.Schema.Types.ObjectId, ref: 'InvoiceSnapshot', default: null },
  finalizedAt: { type: Date, default: null },
  createdBy: { type: ActorSchema, default: () => ({}) },
  updatedBy: { type: ActorSchema, default: () => ({}) },
  finalizedBy: { type: ActorSchema, default: () => ({}) },
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

InvoiceSchema.index({ 'source.provider': 1, 'source.entityType': 1, 'source.entityId': 1, createdAt: -1 });
InvoiceSchema.index({ status: 1, createdAt: -1 });
InvoiceSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $gt: '' } } },
);

module.exports = mongoose.model('Invoice', InvoiceSchema);
