const mongoose = require('mongoose');

const TaskItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  quantity: { type: Number, required: true, min: 1 },
});

const WarehouseTaskSchema = new mongoose.Schema(
  {
    workerId: { type: String, required: true },
    status: { type: String, enum: ['pending', 'in_progress', 'completed', 'failed'], default: 'pending' },
    productItems: { type: [TaskItemSchema], required: true },
    telegramMessageIds: [{ type: String }],
    assignedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WarehouseTask', WarehouseTaskSchema);
