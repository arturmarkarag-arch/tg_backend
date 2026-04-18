const mongoose = require('mongoose');

const BlockSchema = new mongoose.Schema(
  {
    blockId: { type: Number, required: true, unique: true, min: 1 },
    productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    version: { type: Number, default: 0 },
  },
  { timestamps: true }
);

BlockSchema.index({ blockId: 1 });

module.exports = mongoose.model('Block', BlockSchema);
