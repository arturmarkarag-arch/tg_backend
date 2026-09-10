'use strict';

const express = require('express');
const { requireTelegramRole } = require('../middleware/telegramAuth');
const { asyncHandler } = require('../utils/errors');
const { listAllegroAccounts, oauthConfiguration } = require('../services/allegroAccounts');

const router = express.Router();
router.use(requireTelegramRole('admin'));

// Stage 1 operational contract. Orders/shipments/picking endpoints are added in
// later stages, but the admin page can already distinguish "not configured"
// from "accounts exist but still require OAuth" without touching Allegro.
router.get('/status', asyncHandler(async (_req, res) => {
  const accounts = await listAllegroAccounts({ includeDisabled: true });
  const config = oauthConfiguration();
  const connected = accounts.filter((account) => account.authState === 'connected');
  const enabled = connected.filter((account) => account.enabled === true);
  res.set('Cache-Control', 'no-store');
  res.json({
    configured: enabled.length > 0,
    stage: 1,
    oauthConfigured: config.oauthConfigured,
    environment: config.environment,
    accounts,
    summary: {
      total: accounts.length,
      authorizationRequired: accounts.filter((account) => account.authState === 'authorization_required').length,
      connected: connected.length,
      active: enabled.length,
    },
  });
}));

module.exports = router;
