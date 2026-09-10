'use strict';

const express = require('express');
const { requireTelegramRole } = require('../middleware/telegramAuth');
const { asyncHandler } = require('../utils/errors');
const { listAllegroAccounts, oauthConfiguration, publicAllegroAccount } = require('../services/allegroAccounts');
const {
  createOAuthAttempt,
  completeOAuthCallback,
  checkAllegroConnection,
  frontendOAuthRedirect,
} = require('../services/allegroOAuth');

const router = express.Router();

// Allegro redirects the user's browser here without our Telegram/JWT session.
// Security is provided by a high-entropy, one-time state value whose SHA-256
// digest is stored server-side and consumed atomically. This route is the ONLY
// Allegro route intentionally allowed through the global pre-auth gate.
router.get('/oauth/callback', async (req, res, next) => {
  try {
    const result = await completeOAuthCallback({
      state: req.query?.state,
      code: req.query?.code,
      error: req.query?.error,
    });
    const target = frontendOAuthRedirect({ outcome: result.outcome, accountId: result.accountId });
    if (target) return res.redirect(303, target);
    return res.status(200).json({ ok: result.outcome === 'connected', outcome: result.outcome });
  } catch (err) {
    const target = frontendOAuthRedirect({
      outcome: 'error',
      accountId: err?.allegroAccountId || '',
      errorCode: err?.code || 'allegro_oauth_callback_failed',
    });
    if (target) return res.redirect(303, target);
    return next(err);
  }
});

router.use(requireTelegramRole('admin'));

router.get('/status', asyncHandler(async (_req, res) => {
  const accounts = await listAllegroAccounts({ includeDisabled: true });
  const config = oauthConfiguration();
  const connected = accounts.filter((account) => account.authState === 'connected');
  const enabled = connected.filter((account) => account.enabled === true);
  res.set('Cache-Control', 'no-store');
  res.json({
    configured: enabled.length > 0,
    stage: 2,
    oauthConfigured: config.oauthConfigured,
    oauth: config,
    environment: config.environment,
    accounts,
    summary: {
      total: accounts.length,
      authorizationRequired: accounts.filter((account) => account.authState === 'authorization_required').length,
      connected: connected.length,
      active: enabled.length,
      expired: accounts.filter((account) => account.authState === 'expired').length,
      revoked: accounts.filter((account) => account.authState === 'revoked').length,
      error: accounts.filter((account) => account.authState === 'error').length,
    },
  });
}));

router.post('/accounts/:accountId/oauth/start', asyncHandler(async (req, res) => {
  const result = await createOAuthAttempt(req.params.accountId, req.telegramId);
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/accounts/:accountId/connection-check', asyncHandler(async (req, res) => {
  const result = await checkAllegroConnection(req.params.accountId);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    account: publicAllegroAccount(result.account),
    identity: {
      id: result.identity.id,
      login: result.identity.login,
      baseMarketplaceId: result.identity.baseMarketplaceId,
      traceId: result.identity.traceId || '',
    },
  });
}));

module.exports = router;
