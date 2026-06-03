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

// Retention: 365 days. Doubles as the newest-first list index for the vision
// test page (which also has a manual "clear all"). TTL just guarantees the admin
// tooling's results can't pile up forever. A single-field index drives both the
// descending sort and the TTL reaping.
VisionTestLogSchema.index({ createdAt: -1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model('VisionTestLog', VisionTestLogSchema);
