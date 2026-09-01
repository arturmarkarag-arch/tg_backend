'use strict';

const mongoose = require('mongoose');

const TelegramPublicationEventSchema = new mongoose.Schema({
  publicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramPublication', default: null },
  bindingId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramPublicationBinding', default: null },
  destinationKey: { type: String, default: 'new_products' },
  sourceType: { type: String, default: 'receipt_new_product' },
  sourceId: { type: String, default: '' },
  receiptId: { type: String, default: '' },
  eventType: { type: String, required: true },
  operation: { type: String, default: '' },
  actorType: { type: String, enum: ['user', 'worker', 'system', 'telegram'], default: 'system' },
  actorId: { type: String, default: '' },
  fromStatus: { type: String, default: '' },
  toStatus: { type: String, default: '' },
  chatId: { type: String, default: '' },
  messageId: { type: Number, default: null },
  generation: { type: Number, default: null },
  payloadHash: { type: String, default: '' },
  details: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { timestamps: { createdAt: true, updatedAt: false } });

TelegramPublicationEventSchema.index({ publicationId: 1, createdAt: -1 });
TelegramPublicationEventSchema.index({ sourceType: 1, sourceId: 1, createdAt: -1 });
TelegramPublicationEventSchema.index({ destinationKey: 1, eventType: 1, createdAt: -1 });
TelegramPublicationEventSchema.index({ chatId: 1, messageId: 1, createdAt: -1 });

module.exports = mongoose.model('TelegramPublicationEvent', TelegramPublicationEventSchema);
