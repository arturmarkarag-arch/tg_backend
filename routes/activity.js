const express = require('express');
const ActivityLog = require('../models/ActivityLog');

const router = express.Router();

router.get('/', async (req, res) => {
  const logs = await ActivityLog.find().sort({ createdAt: -1 }).limit(100);
  res.json(logs);
});

router.post('/', async (req, res) => {
  const log = new ActivityLog(req.body);
  await log.save();
  res.status(201).json(log);
});

module.exports = router;
