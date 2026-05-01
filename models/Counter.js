const mongoose = require('mongoose');

const CounterSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

CounterSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('Counter', CounterSchema);
