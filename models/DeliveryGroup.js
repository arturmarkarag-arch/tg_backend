const mongoose = require('mongoose');

const DeliveryGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    // Physical delivery weekday. It is intentionally independent from the
    // ordering-session close weekday stored in orderingSchedule.endDay.
    dayOfWeek: {
      type: Number,
      required: true,
      min: 0,
      max: 6,
    },
    orderingSchedule: {
      startDay:    { type: Number, required: true, min: 0, max: 6 },
      startHour:   { type: Number, required: true, min: 0, max: 23 },
      startMinute: { type: Number, required: true, enum: [0, 15, 30, 45] },
      endDay:      { type: Number, required: true, min: 0, max: 6 },
      endHour:     { type: Number, required: true, min: 0, max: 23 },
      endMinute:   { type: Number, required: true, enum: [0, 15, 30, 45] },
    },
    members: [{ type: String }],
  },
  { timestamps: true }
);


// Validate the relationship without coupling the fields: endDay remains fully
// independent, but delivery must still belong to the same weekly session cycle.
DeliveryGroupSchema.pre('validate', function validateScheduleDeliveryCycle(next) {
  if (!this.orderingSchedule || this.dayOfWeek === null || this.dayOfWeek === undefined) return next();
  try {
    const { validateOrderingScheduleDeliveryDay } = require('../utils/orderingSchedule');
    validateOrderingScheduleDeliveryDay(
      this.orderingSchedule.toObject ? this.orderingSchedule.toObject() : this.orderingSchedule,
      Number(this.dayOfWeek),
    );
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('DeliveryGroup', DeliveryGroupSchema);
