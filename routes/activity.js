const express = require('express');
const ActivityLog = require('../models/ActivityLog');
const { requireTelegramRoles } = require('../middleware/telegramAuth');

const router = express.Router();
const staffOnly = requireTelegramRoles(['admin', 'warehouse']);

router.get('/', staffOnly, async (req, res) => {
  const logs = await ActivityLog.find().sort({ createdAt: -1 }).limit(100);
  res.json(logs);
});

router.post('/', staffOnly, async (req, res) => {
  const log = new ActivityLog(req.body);
  await log.save();
  res.status(201).json(log);
});

module.exports = router;
