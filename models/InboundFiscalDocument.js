'use strict';

const mongoose = require('mongoose');

const ErrorSchema = new mongoose.Schema({
  code: { type: String, default: '' },
  message: { type: String, default: '' },
  httpStatus: { type: Number, default: null },
  providerCode: { type: String, default: '' },
  details: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const ArtifactSchema = new mongoose.Schema({
  format: { type: String, required: true, enum: ['xml'] },
  mediaType: { type: String, required: true, default: 'application/xml' },
  contentBase64: { type: String, required: true, select: false },
  encoding: { type: String, required: true, enum: ['base64'], default: 'base64' },
  sha256Hex: { type: String, required: true, trim: true, maxlength: 64 },
  hashBase64: { type: String, required: true, trim: true, maxlength: 64 },
  providerHashBase64: { type: String, required: true, trim: true, maxlength: 64 },
  size: { type: Number, required: true, min: 1 },
  storedAt: { type: Date, required: true },
}, { _id: false });

const ValidationSchema = new mongoose.Schema({
  kind: { type: String, default: '', trim: true, maxlength: 32 },
  state: { type: String, enum: ['pending', 'valid', 'invalid', 'unsupported'], default: 'pending' },
  // `schema` shadows Subdocument#schema. Mongoose's array caster needs that
  // property to remain the real Schema instance while applying defaults.
  schemaName: { type: String, default: '', trim: true, maxlength: 64 },
  checkedAt: { type: Date, default: null },
  // `errors` is a reserved Mongoose Document property. Using it as a nested
  // schema path makes default application recurse through Mongoose's own
  // validation state and prevents every inbound document from being created.
  // Persist under a safe name; the public serializer keeps the API contract.
  issues: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { _id: false });

const FetchSchema = new mongoose.Schema({
  state: { type: String, enum: ['pending', 'running', 'retry_wait', 'complete', 'manual_review'], default: 'pending' },
  attempts: { type: Number, default: 0, min: 0 },
  nextAttemptAt: { type: Date, default: null },
  leaseUntil: { type: Date, default: null },
  lastAttemptAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastError: { type: ErrorSchema, default: null },
}, { _id: false });

const MetadataSchema = new mongoose.Schema({
  invoiceNumber: { type: String, default: '', trim: true, maxlength: 256 },
  issueDate: { type: String, default: '', trim: true, maxlength: 32 },
  invoicingDate: { type: Date, default: null },
  currency: { type: String, default: '', trim: true, maxlength: 8 },
  netAmount: { type: String, default: '', trim: true, maxlength: 64 },
  vatAmount: { type: String, default: '', trim: true, maxlength: 64 },
  grossAmount: { type: String, default: '', trim: true, maxlength: 64 },
  seller: { type: mongoose.Schema.Types.Mixed, default: null },
  buyer: { type: mongoose.Schema.Types.Mixed, default: null },
  thirdSubjects: { type: [mongoose.Schema.Types.Mixed], default: [] },
  authorizedSubject: { type: mongoose.Schema.Types.Mixed, default: null },
  providerDetails: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

// Provider-neutral local representation of a received fiscal document. Provider-
// specific identifiers/roles/cursors live in adapters (for KSeF: inboundSync).
const InboundFiscalDocumentSchema = new mongoose.Schema({
  provider: { type: String, required: true, trim: true, maxlength: 64 },
  legalEntityId: { type: mongoose.Schema.Types.ObjectId, ref: 'LegalEntity', required: true },
  environment: { type: String, required: true, trim: true, maxlength: 32 },
  sourceRole: { type: String, required: true, enum: ['seller', 'buyer', 'third', 'authorized', 'other'] },
  sourceSyncId: { type: String, required: true, trim: true, maxlength: 128 },

  providerDocumentId: { type: String, required: true, trim: true, maxlength: 160 },
  providerArtifactHashBase64: { type: String, required: true, trim: true, maxlength: 64 },
  providerStoredAt: { type: Date, default: null },
  metadata: { type: MetadataSchema, required: true },

  artifactState: {
    type: String,
    enum: ['pending_fetch', 'fetching', 'stored', 'stored_warning', 'manual_review'],
    default: 'pending_fetch',
    index: true,
  },
  artifact: { type: ArtifactSchema, default: null },
  validation: { type: ValidationSchema, default: () => ({ state: 'pending' }) },
  fetch: { type: FetchSchema, default: () => ({ state: 'pending', nextAttemptAt: new Date() }) },

  firstSeenAt: { type: Date, required: true, default: Date.now },
  lastSeenAt: { type: Date, required: true, default: Date.now },
  lastError: { type: ErrorSchema, default: null },
}, { timestamps: true, optimisticConcurrency: true });

InboundFiscalDocumentSchema.index(
  { provider: 1, legalEntityId: 1, environment: 1, providerDocumentId: 1 },
  { unique: true },
);
InboundFiscalDocumentSchema.index({ legalEntityId: 1, environment: 1, sourceRole: 1, providerStoredAt: -1 });
InboundFiscalDocumentSchema.index({ provider: 1, artifactState: 1, 'fetch.nextAttemptAt': 1, 'fetch.leaseUntil': 1 });
InboundFiscalDocumentSchema.index({ sourceSyncId: 1, artifactState: 1, createdAt: 1 });

module.exports = mongoose.model('InboundFiscalDocument', InboundFiscalDocumentSchema);
