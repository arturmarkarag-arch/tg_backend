const mongoose = require('mongoose');

const EgressTrafficSampleSchema = new mongoose.Schema({
  startedAt: { type: Date, required: true, index: true },
  endedAt: { type: Date, required: true, index: true },
  transport: { type: [mongoose.Schema.Types.Mixed], default: [] },
  http: { type: [mongoose.Schema.Types.Mixed], default: [] },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, {
  collection: 'egresstrafficsamples',
  minimize: false,
  versionKey: false,
});

module.exports = mongoose.models.EgressTrafficSample
  || mongoose.model('EgressTrafficSample', EgressTrafficSampleSchema);
