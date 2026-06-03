const mongoose = require('mongoose');

const receiptItemLogSchema = new mongoose.Schema(
  {
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt', required: true, index: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReceiptItem' },
    itemName: { type: String, default: '' },
    action: { type: String, enum: ['create', 'update', 'delete', 'confirm', 'move_to_block', 'receipt_create', 'receipt_complete', 'resolve_pending'], required: true },
    actor: {
      telegramId: { type: String, default: '' },
      firstName: { type: String, default: '' },
      lastName: { type: String, default: '' },
    },
    changes: {
      type: [
        {
          _id: false,
          field: { type: String, default: '' },
          label: { type: String, default: '' },
          from: { type: mongoose.Schema.Types.Mixed },
          to: { type: mongoose.Schema.Types.Mixed },
        },
      ],
      default: [],
    },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Retention: 365 days. This per-receipt change log IS displayed (receipt detail
// → GET /receipts/:id/logs), but a receipt's edit history stops being useful
// long before a year passes, so the TTL bounds the collection without touching
// anything operationally relevant.
receiptItemLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model('ReceiptItemLog', receiptItemLogSchema);
