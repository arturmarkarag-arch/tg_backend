const mongoose = require('mongoose');

const ResultItemSchema = new mongoose.Schema({
  assetId:     { type: String, required: true },
  score:       { type: Number, required: true },
  shopProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'ShopProduct', default: null },
}, { _id: false });

const VisionTestLogSchema = new mongoose.Schema({
  results:       { type: [ResultItemSchema], default: [] },
  reasoning:     { type: String, default: '' },
  threshold:     { type: Number, default: 0 },
  markedCorrect: { type: Boolean, default: null },
  note:          { type: String, default: '' },
  createdBy:     { type: String, default: '' },
}, { timestamps: true });

VisionTestLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('VisionTestLog', VisionTestLogSchema);
