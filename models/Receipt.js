const mongoose = require('mongoose');

const ReceiptSchema = new mongoose.Schema(
  {
    receiptNumber: { type: String, required: true, unique: true },
    status: { type: String, enum: ['draft', 'completed'], default: 'draft' },
    createdBy: { type: String, required: true },
    assignedTo: { type: String, default: null },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Receipt', ReceiptSchema);
