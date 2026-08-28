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

    // Modern photo intake is created automatically from one bulk upload. The
    // Receipt remains a durable audit/container boundary, but workers no longer
    // create or commit it manually in the primary UI. `intakeBatchId` is the
    // idempotency key for retrying an unknown HTTP result without duplicating
    // ReceiptItems.
    intakeMode: { type: String, enum: ['manual', 'bulk'], default: 'manual' },
    intakeBatchId: { type: String, default: null },

    // LEGACY COMPATIBILITY: current UI creates only `regular` receipts. New
    // supplement intent lives per ReceiptItem.routing; `type='supplement'` and
    // receipt-level target fields remain only so historical receipts/old clients
    // keep working without a destructive migration.
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
ReceiptSchema.index(
  { intakeBatchId: 1 },
  { unique: true, partialFilterExpression: { intakeBatchId: { $type: 'string' } } },
);

module.exports = mongoose.model('Receipt', ReceiptSchema);
