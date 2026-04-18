const mongoose = require('mongoose');

const ActivityLogSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    type: { type: String, required: true },
    action: { type: String, required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    details: { type: Object, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ActivityLog', ActivityLogSchema);
