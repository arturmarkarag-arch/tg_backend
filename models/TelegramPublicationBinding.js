'use strict';

const mongoose = require('mongoose');

const TelegramPublicationBindingSchema = new mongoose.Schema({
  publicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramPublication', required: true },
  sourceId: { type: String, required: true },
  receiptId: { type: String, default: '' },
  generation: { type: Number, required: true, min: 1 },
  chatId: { type: String, required: true },
  destinationConfigRevision: { type: Number, default: 0, min: 0 },
  messageId: { type: Number, default: null },
  state: {
    type: String,
    enum: ['creating', 'live', 'unknown', 'missing', 'deleted', 'manual_required', 'resolved', 'superseded'],
    default: 'creating',
  },
  telegramPhotoFileId: { type: String, default: '' },
  payloadHash: { type: String, default: '' },
  snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  caption: { type: String, default: '' },
  createAttemptAt: { type: Date, default: null },
  confirmedAt: { type: Date, default: null },
  lastEditedAt: { type: Date, default: null },
  lastVerifiedAt: { type: Date, default: null },
  accessCode: { type: String, default: '' },
  canEdit: { type: Boolean, default: null },
  canDelete: { type: Boolean, default: null },
  lastMembershipEventAt: { type: Date, default: null },
  unknownAt: { type: Date, default: null },
  missingAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: String, default: '' },
  resolutionNote: { type: String, default: '' },
  lastError: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { timestamps: true });

TelegramPublicationBindingSchema.index({ publicationId: 1, generation: 1 }, { unique: true });
TelegramPublicationBindingSchema.index(
  { chatId: 1, messageId: 1 },
  { unique: true, partialFilterExpression: { messageId: { $type: 'number' } } },
);
TelegramPublicationBindingSchema.index({ publicationId: 1, state: 1, createdAt: 1 });

module.exports = mongoose.model('TelegramPublicationBinding', TelegramPublicationBindingSchema);
