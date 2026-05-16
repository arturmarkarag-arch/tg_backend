'use strict';

const mongoose = require('mongoose');

const OrderingSessionSchema = new mongoose.Schema(
  {
    groupId:  { type: String, required: true },
    // "YYYY-MM-DD" in Warsaw timezone — the calendar date the window opens on.
    // Using the date (not the exact timestamp) means a time change by the admin
    // (e.g. 16:00 → 15:00) does NOT produce a new session document, so all orders
    // placed before the schedule change stay associated with the same session.
    openDate: { type: String, required: true },
    openAt:   { type: Date },
  },
  { timestamps: true },
);

OrderingSessionSchema.index({ groupId: 1, openDate: 1 }, { unique: true });

module.exports = mongoose.model('OrderingSession', OrderingSessionSchema);
