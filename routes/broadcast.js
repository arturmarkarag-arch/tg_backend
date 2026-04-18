/**
 * REST API routes for broadcast control.
 *
 * POST   /api/broadcast/start   - Start a new broadcast
 * GET    /api/broadcast/stats   - Get current broadcast queue stats
 * POST   /api/broadcast/cancel  - Cancel/drain all pending broadcast jobs
 */
const express = require('express');
const { startBroadcast, getBroadcastStats, cancelBroadcast } = require('../broadcast/broadcastService');

const router = express.Router();

// POST /api/broadcast/start
router.post('/start', async (req, res) => {
  try {
    const { productFilter, recipientRole, recipientIds, addLabels } = req.body || {};

    // Sanitize productFilter to prevent MongoDB query injection
    const safeFilter = {};
    if (productFilter && typeof productFilter === 'object') {
      const allowedKeys = ['status', 'deliveryGroup', 'category', 'brand'];
      for (const key of allowedKeys) {
        if (productFilter[key] !== undefined) {
          // Only allow string values, not operators like $where/$gt
          if (typeof productFilter[key] === 'string') {
            safeFilter[key] = productFilter[key];
          }
        }
      }
    } else {
      safeFilter.status = 'active';
    }

    const result = await startBroadcast({
      productFilter: safeFilter,
      recipientRole,
      recipientIds,
      addLabels,
    });
    res.json(result);
  } catch (err) {
    console.error('[Broadcast API] Start error:', err);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/broadcast/stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await getBroadcastStats();
    res.json(stats);
  } catch (err) {
    console.error('[Broadcast API] Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/broadcast/cancel
router.post('/cancel', async (req, res) => {
  try {
    const result = await cancelBroadcast();
    res.json(result);
  } catch (err) {
    console.error('[Broadcast API] Cancel error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
