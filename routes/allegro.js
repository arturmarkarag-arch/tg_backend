'use strict';

const express = require('express');
const { requireTelegramRole } = require('../middleware/telegramAuth');
const { asyncHandler } = require('../utils/errors');
const { listAllegroAccounts, oauthConfiguration, publicAllegroAccount } = require('../services/allegroAccounts');
const {
  createOAuthAttempt,
  completeOAuthCallback,
  frontendOAuthRedirect,
  forceRefreshAllegroAccessToken,
} = require('../services/allegroOAuth');
const {
  getAllegroApiUsage,
  listAllegroApiErrors,
  checkAllegroApiConnection,
} = require('../services/allegroHttpClient');
const {
  getAllegroOrderSyncStates,
  getAllegroOrderPage,
  getLocalAllegroOrder,
  syncAllegroOrders,
  forceRebootstrapAllegroAccount,
} = require('../services/allegroOrders');
const { isAllegroOrderSchedulerStarted, ORDER_POLL_MS } = require('../services/allegroOrderScheduler');

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
  const accountIds = accounts.map((account) => account.accountId);
  const [usage, syncStates] = await Promise.all([
    getAllegroApiUsage(accountIds),
    getAllegroOrderSyncStates(accountIds),
  ]);
  const syncByAccountId = new Map(syncStates.map((state) => [String(state.accountId), state]));
  const accountsWithSync = accounts.map((account) => ({
    ...account,
    orderSync: syncByAccountId.get(String(account.accountId)) || null,
  }));
  const healthCounts = accountsWithSync.reduce((acc, account) => {
    const health = String(account?.orderSync?.health || 'pending');
    acc[health] = (acc[health] || 0) + 1;
    return acc;
  }, {});
  res.set('Cache-Control', 'no-store');
  res.json({
    configured: enabled.length > 0,
    stage: 4,
    hardeningStage: '4.3',
    provider: 'allegro',
    independentProvider: true,
    oauthConfigured: config.oauthConfigured,
    oauth: config,
    environment: config.environment,
    accounts: accountsWithSync,
    orderSchedulerStarted: isAllegroOrderSchedulerStarted(),
    orderPollMs: ORDER_POLL_MS,
    api: {
      officialLimitPerMinute: usage.officialLimitPerMinute,
      configuredBudgetPerMinute: usage.configuredBudgetPerMinute,
      effectiveBudgetPerMinute: usage.effectiveBudgetPerMinute,
      coordinationMode: usage.coordinationMode,
      accountMaxConcurrency: usage.accountMaxConcurrency,
      timeoutMs: Number(process.env.ALLEGRO_HTTP_TIMEOUT_MS) || 15000,
      errorRetentionDays: Number(process.env.ALLEGRO_ERROR_RETENTION_DAYS) || 14,
    },
    summary: {
      total: accounts.length,
      authorizationRequired: accounts.filter((account) => account.authState === 'authorization_required').length,
      connected: connected.length,
      active: enabled.length,
      expired: accounts.filter((account) => account.authState === 'expired').length,
      revoked: accounts.filter((account) => account.authState === 'revoked').length,
      error: accounts.filter((account) => account.authState === 'error').length,
      orderSyncHealth: healthCounts,
    },
  });
}));

router.get('/api-usage', asyncHandler(async (_req, res) => {
  const accounts = await listAllegroAccounts({ includeDisabled: true });
  res.set('Cache-Control', 'no-store');
  res.json(await getAllegroApiUsage(accounts.map((account) => account.accountId)));
}));

router.get('/errors', asyncHandler(async (req, res) => {
  const rows = await listAllegroApiErrors({
    accountId: req.query?.accountId,
    limit: req.query?.limit,
  });
  res.set('Cache-Control', 'no-store');
  res.json({ errors: rows });
}));

router.post('/accounts/:accountId/oauth/start', asyncHandler(async (req, res) => {
  const result = await createOAuthAttempt(req.params.accountId, req.telegramId);
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/accounts/:accountId/connection-check', asyncHandler(async (req, res) => {
  const result = await checkAllegroApiConnection(req.params.accountId);
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
    requestId: result.requestId || '',
  });
}));

router.post('/accounts/:accountId/token-refresh', asyncHandler(async (req, res) => {
  const refreshed = await forceRefreshAllegroAccessToken(req.params.accountId);
  const accounts = await listAllegroAccounts({ includeDisabled: true });
  const account = accounts.find((row) => String(row.accountId) === String(req.params.accountId)) || null;
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    account,
    token: {
      tokenRevision: refreshed.tokenRevision,
      tokenExpiresAt: refreshed.tokenExpiresAt,
      tokenRefreshedAt: refreshed.tokenRefreshedAt,
    },
  });
}));

router.post('/accounts/:accountId/orders/rebootstrap', asyncHandler(async (req, res) => {
  const result = await forceRebootstrapAllegroAccount(req.params.accountId);
  res.set('Cache-Control', 'no-store');
  res.json({ ...result, rebootstrap: true, syncedAt: new Date().toISOString() });
}));

router.get('/orders', asyncHandler(async (req, res) => {
  const result = await getAllegroOrderPage({
    accountId: req.query?.accountId,
    workflowFilter: req.query?.workflowFilter,
    search: req.query?.search,
    page: req.query?.page,
    pageSize: req.query?.pageSize,
  });
  res.set('Cache-Control', 'no-store');
  res.json({ ...result, fetchedAt: new Date().toISOString() });
}));

router.get('/accounts/:accountId/orders/:orderId', asyncHandler(async (req, res) => {
  const order = await getLocalAllegroOrder(req.params.accountId, req.params.orderId);
  res.set('Cache-Control', 'no-store');
  res.json({ order, fetchedAt: new Date().toISOString() });
}));

router.post('/sync', asyncHandler(async (req, res) => {
  const result = await syncAllegroOrders({ accountId: req.body?.accountId });
  res.set('Cache-Control', 'no-store');
  res.json({ ...result, syncedAt: new Date().toISOString() });
}));

module.exports = router;
