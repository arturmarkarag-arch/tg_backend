const mongoose = require('mongoose');

const CitySchema = new mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true, unique: true },
    country: { type: String, default: 'PL', trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('City', CitySchema);
