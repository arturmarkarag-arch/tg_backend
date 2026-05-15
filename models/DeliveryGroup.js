const mongoose = require('mongoose');

const DeliveryGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    dayOfWeek: {
      type: Number,
      required: true,
      min: 0,
      max: 6,
    },
    members: [{ type: String }],
    pickingConfirmedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DeliveryGroup', DeliveryGroupSchema);
