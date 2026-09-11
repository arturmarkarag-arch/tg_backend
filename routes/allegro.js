'use strict';

const express = require('express');
const { requireTelegramRole } = require('../middleware/telegramAuth');
const { requireMarketplaceWarehouseAccess } = require('../utils/marketplaceWarehouseAccess');
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
const {
  getPickingStates,
  getMyActivePicking,
  claimPickingOrder,
  heartbeatPickingOrder,
  updatePickingItem,
  releasePickingOrder,
  markPickingOrderSent,
  acknowledgeUpstreamReview,
  reopenPickingOrder,
} = require('../services/allegroPicking');

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


router.get('/status', requireMarketplaceWarehouseAccess, asyncHandler(async (_req, res) => {
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
    stage: 5,
    hardeningStage: '5.0',
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

router.get('/api-usage', requireTelegramRole('admin'), asyncHandler(async (_req, res) => {
  const accounts = await listAllegroAccounts({ includeDisabled: true });
  res.set('Cache-Control', 'no-store');
  res.json(await getAllegroApiUsage(accounts.map((account) => account.accountId)));
}));

router.get('/errors', requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const rows = await listAllegroApiErrors({
    accountId: req.query?.accountId,
    limit: req.query?.limit,
  });
  res.set('Cache-Control', 'no-store');
  res.json({ errors: rows });
}));

router.post('/accounts/:accountId/oauth/start', requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const result = await createOAuthAttempt(req.params.accountId, req.telegramId);
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/accounts/:accountId/connection-check', requireTelegramRole('admin'), asyncHandler(async (req, res) => {
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

router.post('/accounts/:accountId/token-refresh', requireTelegramRole('admin'), asyncHandler(async (req, res) => {
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

router.post('/accounts/:accountId/orders/rebootstrap', requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const result = await forceRebootstrapAllegroAccount(req.params.accountId);
  res.set('Cache-Control', 'no-store');
  res.json({ ...result, rebootstrap: true, syncedAt: new Date().toISOString() });
}));

router.get('/orders', requireMarketplaceWarehouseAccess, asyncHandler(async (req, res) => {
  const result = await getAllegroOrderPage({
    accountId: req.query?.accountId,
    workflowFilter: req.query?.workflowFilter,
    sentBy: req.query?.sentBy,
    search: req.query?.search,
    page: req.query?.page,
    pageSize: req.query?.pageSize,
  });
  res.set('Cache-Control', 'no-store');
  res.json({ ...result, fetchedAt: new Date().toISOString() });
}));

router.get('/accounts/:accountId/orders/:orderId', requireMarketplaceWarehouseAccess, asyncHandler(async (req, res) => {
  const order = await getLocalAllegroOrder(req.params.accountId, req.params.orderId);
  const key = `${String(req.params.accountId || '').trim()}:${String(req.params.orderId || '').trim()}`;
  const pickingStates = await getPickingStates([{ allegroAccountId: req.params.accountId, orderId: req.params.orderId }]);
  res.set('Cache-Control', 'no-store');
  res.json({ order, pickingState: pickingStates[key] || null, fetchedAt: new Date().toISOString() });
}));

router.get('/picking/my-active', requireMarketplaceWarehouseAccess, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ state: await getMyActivePicking(req.telegramUser) });
}));

function mutationId(req) {
  return String(req.body?.clientMutationId || '').trim().slice(0, 160);
}

const pickingPrefix = '/accounts/:accountId/picking/orders/:orderId';
router.get(pickingPrefix, requireMarketplaceWarehouseAccess, asyncHandler(async (req, res) => {
  const key = `${String(req.params.accountId || '').trim()}:${String(req.params.orderId || '').trim()}`;
  const states = await getPickingStates([{ allegroAccountId: req.params.accountId, orderId: req.params.orderId }]);
  res.json({ state: states[key] || null });
}));
router.post(`${pickingPrefix}/claim`, requireMarketplaceWarehouseAccess, asyncHandler(async (req, res) => {
  res.json(await claimPickingOrder({ allegroAccountId: req.params.accountId, orderId: req.params.orderId, user: req.telegramUser, force: req.body?.force === true, clientMutationId: mutationId(req) }));
}));
router.post(`${pickingPrefix}/heartbeat`, requireMarketplaceWarehouseAccess, asyncHandler(async (req, res) => {
  res.json(await heartbeatPickingOrder({ allegroAccountId: req.params.accountId, orderId: req.params.orderId, user: req.telegramUser }));
}));
router.patch(`${pickingPrefix}/items/:lineKey`, requireMarketplaceWarehouseAccess, asyncHandler(async (req, res) => {
  res.json(await updatePickingItem({
    allegroAccountId: req.params.accountId,
    orderId: req.params.orderId,
    lineKey: req.params.lineKey,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
    state: req.body?.state,
    pickedQty: req.body?.pickedQty,
    issueNote: req.body?.issueNote,
    clientMutationId: mutationId(req),
  }));
}));
router.post(`${pickingPrefix}/release`, requireMarketplaceWarehouseAccess, asyncHandler(async (req, res) => {
  res.json(await releasePickingOrder({ allegroAccountId: req.params.accountId, orderId: req.params.orderId, user: req.telegramUser, expectedRevision: req.body?.expectedRevision, force: req.body?.force === true, clientMutationId: mutationId(req) }));
}));
router.post(`${pickingPrefix}/sent`, requireMarketplaceWarehouseAccess, asyncHandler(async (req, res) => {
  res.json(await markPickingOrderSent({ allegroAccountId: req.params.accountId, orderId: req.params.orderId, user: req.telegramUser, expectedRevision: req.body?.expectedRevision, clientMutationId: mutationId(req) }));
}));
router.post(`${pickingPrefix}/upstream-reviewed`, requireMarketplaceWarehouseAccess, asyncHandler(async (req, res) => {
  res.json(await acknowledgeUpstreamReview({ allegroAccountId: req.params.accountId, orderId: req.params.orderId, user: req.telegramUser, expectedRevision: req.body?.expectedRevision, clientMutationId: mutationId(req) }));
}));
router.post(`${pickingPrefix}/reopen`, requireMarketplaceWarehouseAccess, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  res.json(await reopenPickingOrder({ allegroAccountId: req.params.accountId, orderId: req.params.orderId, user: req.telegramUser, expectedRevision: req.body?.expectedRevision, clientMutationId: mutationId(req) }));
}));

router.post('/sync', requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const result = await syncAllegroOrders({ accountId: req.body?.accountId });
  res.set('Cache-Control', 'no-store');
  res.json({ ...result, syncedAt: new Date().toISOString() });
}));

module.exports = router;
