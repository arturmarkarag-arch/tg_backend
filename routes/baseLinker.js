const express = require('express');
const { requireTelegramRole } = require('../middleware/telegramAuth');
const { requireBaseLinkerPickingAccess } = require('../utils/baseLinkerAccess');
const { asyncHandler, appError } = require('../utils/errors');
const { isBaseLinkerConfigured } = require('../services/baseLinkerClient');
const { getPrintAgentStatus, queuePrintJob } = require('../services/baseLinkerPrint');
const { fetchBaseLinkerOrders, fetchBaseLinkerOrderMeta } = require('../services/baseLinkerOrders');
const { getCachedOrderPage, cacheState, syncBaseLinkerOrderCache } = require('../services/baseLinkerOrderCache');
const {
  loadJournalState,
  TICK_MS,
  DEGRADED_RECONCILE_MS,
  isBaseLinkerJournalSchedulerStarted,
} = require('../services/baseLinkerJournal');
const { getQueueScope } = require('../services/baseLinkerQueueScope');
const { getBaseLinkerAccountScope, getBaseLinkerAccountBinding } = require('../services/baseLinkerAccount');
const { fetchBaseLinkerProductCatalog } = require('../services/baseLinkerProducts');
const { compactOrders, compactProductCatalog } = require('../services/baseLinkerPublicDto');
const {
  fetchBaseLinkerOrderPackages,
  fetchVerifiedBaseLinkerOrderPackage,
  fetchVerifiedBaseLinkerOrderLabel,
} = require('../services/baseLinkerShipments');
const {
  getPickingStates,
  getMyActivePicking,
  claimPickingOrder,
  heartbeatPickingOrder,
  updatePickingItem,
  releasePickingOrder,
  markPickingOrderPacked,
  markPickingOrderSent,
  reopenPickingOrder,
  acknowledgeUpstreamReview,
} = require('../services/baseLinkerPicking');

const router = express.Router();

// BaseLinker is available only to admins and the dedicated `baselinker` role.
// The boundary is server-side; hiding a navigation item in React is never
// treated as authorization.
router.use(requireBaseLinkerPickingAccess);

router.get('/status', asyncHandler(async (req, res) => {
  const [cache, journal] = await Promise.all([cacheState(), loadJournalState()]);
  const scope = await getQueueScope();
  const binding = getBaseLinkerAccountBinding();
  res.json({
    configured: isBaseLinkerConfigured(),
    accountScope: scope.accountScope,
    accountIdentitySource: binding.source,
    accountIdentityStable: binding.stable === true,
    queueConfigured: scope.configured,
    intakeStatusId: scope.intakeStatusId,
    intakeStatusName: scope.intakeStatusName,
    sentStatusId: scope.sentStatusId,
    sentStatusName: scope.sentStatusName,
    cancelledStatusId: scope.cancelledStatusId,
    cancelledStatusName: scope.cancelledStatusName,
    sentLookbackDays: scope.sentLookbackDays,
    cacheInitialized: cache.initialized,
    lastFullSyncAt: cache.lastFullSyncAt,
    fallbackCheckedOrderCount: cache.fallbackCheckedOrderCount,
    fallbackPendingOrderCount: cache.fallbackPendingOrderCount,
    journalInitialized: journal.initialized,
    journalSchedulerStarted: isBaseLinkerJournalSchedulerStarted(),
    journalPossiblyDisabled: journal.possiblyDisabled === true,
    journalLastLogId: journal.lastLogId,
    journalLastChangeAt: journal.lastChangeAt,
    journalPollMs: TICK_MS,
    degradedReconcileMs: DEGRADED_RECONCILE_MS,
    lastJournalSuccessAt: journal.lastSuccessAt,
    lastError: journal.lastError,
    nextRetryAt: journal.nextRetryAt,
  });
}));

router.post('/sync', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  const result = await syncBaseLinkerOrderCache({ force: true });
  res.json({ ...result, accountScope: getBaseLinkerAccountScope(), syncedAt: new Date().toISOString() });
}));

router.get('/meta', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  const meta = await fetchBaseLinkerOrderMeta();
  res.json(meta);
}));

router.get('/orders', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');

  const exactOrderId = String(req.query.orderId || '').trim();
  let result;

  if (exactOrderId) {
    // Exact reads stay live. Claim/pack/reconciliation depend on current
    // BaseLinker truth and must never be satisfied only from the UI cache.
    result = await fetchBaseLinkerOrders({
      orderId: exactOrderId,
      includeUnconfirmed: req.query.includeUnconfirmed === '1' || req.query.includeUnconfirmed === 'true',
      maxPages: 1,
    });
  } else {
    // The work queue is server-paginated from a dedicated BaseLinker snapshot
    // cache. The browser receives only the requested 10/20/50 exact order rows;
    // it no longer downloads/scans the whole account on every page render.
    result = await getCachedOrderPage({
      statusId: req.query.statusId,
      workflowFilter: req.query.workflowFilter,
      packedBy: req.query.packedBy,
      search: req.query.search,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
  }

  // getOrders intentionally contains the order-line snapshot, not full catalog
  // media/details. Resolve current product catalog data only for this page.
  let catalog = {
    productCatalog: {},
    productCatalogStats: { requested: 0, resolved: 0, unresolved: 0, warnings: 0 },
    productCatalogWarnings: [],
  };
  try {
    catalog = await fetchBaseLinkerProductCatalog(result.orders || []);
  } catch (error) {
    catalog.productCatalogWarnings = [{
      scope: 'catalog',
      code: error?.code || error?.message || 'catalog_lookup_failed',
    }];
    catalog.productCatalogStats.warnings = 1;
  }

  const pickingStates = await getPickingStates((result.orders || []).map((order) => order?.order_id));

  res.json({
    ...result,
    accountScope: getBaseLinkerAccountScope(),
    orders: compactOrders(result.orders || []),
    productCatalog: compactProductCatalog(catalog.productCatalog || {}),
    productCatalogStats: catalog.productCatalogStats,
    pickingStates,
    fetchedAt: new Date().toISOString(),
  });
}));

router.get('/orders/:orderId/packages', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  const result = await fetchBaseLinkerOrderPackages(req.params.orderId);
  res.json({ ...result, fetchedAt: new Date().toISOString() });
}));

router.get('/orders/:orderId/packages/:packageId/details', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  const result = await fetchVerifiedBaseLinkerOrderPackage({
    orderId: req.params.orderId,
    packageId: req.params.packageId,
    courierCode: req.query.courierCode,
  });
  res.json({ ...result, accountScope: getBaseLinkerAccountScope(), fetchedAt: new Date().toISOString() });
}));

router.get('/orders/:orderId/packages/:packageId/label', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  const label = await fetchVerifiedBaseLinkerOrderLabel({
    orderId: req.params.orderId,
    packageId: req.params.packageId,
    courierCode: req.query.courierCode,
  });

  const safeExtension = /^[a-z0-9]{1,8}$/.test(label.extension) ? label.extension : 'bin';
  res.set({
    'Content-Type': label.contentType,
    'Content-Length': String(label.buffer.length),
    'Content-Disposition': `inline; filename="baselinker-label-${label.packageId}.${safeExtension}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-BaseLinker-Label-Extension': safeExtension,
  });
  res.send(label.buffer);
}));


router.get('/print-agent/status', asyncHandler(async (req, res) => {
  res.json(await getPrintAgentStatus());
}));

router.post('/orders/:orderId/packages/:packageId/print', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  const job = await queuePrintJob({
    orderId: req.params.orderId,
    packageId: req.params.packageId,
    courierCode: req.body?.courierCode,
    user: req.telegramUser,
  });
  res.status(202).json({ job });
}));



function clientMutationIdFromRequest(req) {
  return String(req.body?.clientMutationId || '').trim().slice(0, 160);
}

// ── Fulfilment workflow ─────────────────────────────────────────────────────
// Picking/problem/packing state is a local 1:1 overlay on exact BaseLinker
// order_id. The sole upstream mutation is "Sent": exact setOrderStatus followed
// by exact getOrders verification before local Sent can be persisted.
router.get('/picking/my-active', asyncHandler(async (req, res) => {
  res.json({ state: await getMyActivePicking(req.telegramUser) });
}));

router.get('/picking/orders/:orderId', asyncHandler(async (req, res) => {
  const states = await getPickingStates([req.params.orderId]);
  res.json({ state: states[String(req.params.orderId)] || null });
}));

router.post('/picking/orders/:orderId/claim', asyncHandler(async (req, res) => {
  const clientMutationId = clientMutationIdFromRequest(req);
  const result = await claimPickingOrder({
    orderId: req.params.orderId,
    user: req.telegramUser,
    force: req.body?.force === true,
    clientMutationId,
  });
  res.json({ ...result, ...(clientMutationId ? { clientMutationId } : {}) });
}));

router.post('/picking/orders/:orderId/heartbeat', asyncHandler(async (req, res) => {
  res.json(await heartbeatPickingOrder({
    orderId: req.params.orderId,
    user: req.telegramUser,
  }));
}));

router.patch('/picking/orders/:orderId/items/:lineKey', asyncHandler(async (req, res) => {
  const clientMutationId = clientMutationIdFromRequest(req);
  const state = await updatePickingItem({
    orderId: req.params.orderId,
    lineKey: req.params.lineKey,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
    state: req.body?.state,
    pickedQty: req.body?.pickedQty,
    issueNote: req.body?.issueNote,
    clientMutationId,
  });
  res.json({ state, ...(clientMutationId ? { clientMutationId } : {}) });
}));

router.post('/picking/orders/:orderId/release', asyncHandler(async (req, res) => {
  const clientMutationId = clientMutationIdFromRequest(req);
  const state = await releasePickingOrder({
    orderId: req.params.orderId,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
    force: req.body?.force === true,
    clientMutationId,
  });
  res.json({ state, ...(clientMutationId ? { clientMutationId } : {}) });
}));

router.post('/picking/orders/:orderId/packed', asyncHandler(async (req, res) => {
  const clientMutationId = clientMutationIdFromRequest(req);
  const result = await markPickingOrderPacked({
    orderId: req.params.orderId,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
    clientMutationId,
  });
  res.json({ ...result, ...(clientMutationId ? { clientMutationId } : {}) });
}));

router.post('/picking/orders/:orderId/sent', asyncHandler(async (req, res) => {
  const clientMutationId = clientMutationIdFromRequest(req);
  const result = await markPickingOrderSent({
    orderId: req.params.orderId,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
    clientMutationId,
  });
  res.json({ ...result, ...(clientMutationId ? { clientMutationId } : {}) });
}));

router.post('/picking/orders/:orderId/upstream-reviewed', asyncHandler(async (req, res) => {
  const clientMutationId = clientMutationIdFromRequest(req);
  const state = await acknowledgeUpstreamReview({
    orderId: req.params.orderId,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
    clientMutationId,
  });
  res.json({ state, ...(clientMutationId ? { clientMutationId } : {}) });
}));

router.post('/picking/orders/:orderId/reopen', requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const clientMutationId = clientMutationIdFromRequest(req);
  const state = await reopenPickingOrder({
    orderId: req.params.orderId,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
    clientMutationId,
  });
  res.json({ state, ...(clientMutationId ? { clientMutationId } : {}) });
}));

module.exports = router;
