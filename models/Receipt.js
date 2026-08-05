const mongoose = require('mongoose');

// Актуальна бізнес-логіка: docs/receipt/readme.md
const ReceiptSchema = new mongoose.Schema(
  {
    receiptNumber: { type: String, required: true, unique: true },
    status: { type: String, enum: ['draft', 'completed'], default: 'draft' },
    createdBy: { type: String, required: true },
    assignedTo: { type: String, default: null },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },

    type: { type: String, enum: ['regular', 'supplement'], default: 'regular' },
    targetDeliveryGroupId: { type: String, default: null },
    supplementOpenedAt: { type: Date, default: null },
    // Лише сумісність зі старими документами. Нова логіка дедлайну не має.
    supplementClosesAt: { type: Date, default: null },
    supplementStatus: { type: String, enum: ['pending', 'ready', null], default: null },
  },
  { timestamps: true },
);

ReceiptSchema.index({ supplementStatus: 1 }, { sparse: true });

module.exports = mongoose.model('Receipt', ReceiptSchema);
