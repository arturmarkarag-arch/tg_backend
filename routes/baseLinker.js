const express = require('express');
const { requireTelegramRole } = require('../middleware/telegramAuth');
const { requireBaseLinkerPickingAccess } = require('../utils/baseLinkerAccess');
const { asyncHandler, appError } = require('../utils/errors');
const { isBaseLinkerConfigured } = require('../services/baseLinkerClient');
const { getPrintAgentStatus, queuePrintJob } = require('../services/baseLinkerPrint');
const { fetchBaseLinkerOrders, fetchBaseLinkerOrderMeta } = require('../services/baseLinkerOrders');
const {
  getIndexedOrderPage,
  getLocalOrderProjection,
  loadIndexState,
  syncBaseLinkerOrderIndex,
  INDEX_REFRESH_MS,
  TERMINAL_INDEX_REFRESH_MS,
} = require('../services/baseLinkerOrderIndex');
const { isBaseLinkerQueueSchedulerStarted } = require('../services/baseLinkerQueueScheduler');
const { getQueueScope } = require('../services/baseLinkerQueueScope');
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
  const scope = await getQueueScope();
  const index = await loadIndexState(scope);
  res.json({
    configured: isBaseLinkerConfigured(),
    queueConfigured: scope.configured,
    intakeStatusId: scope.intakeStatusId,
    intakeStatusName: scope.intakeStatusName,
    sentStatusId: scope.sentStatusId,
    sentStatusName: scope.sentStatusName,
    cancelledStatusId: scope.cancelledStatusId,
    cancelledStatusName: scope.cancelledStatusName,
    historyLookbackDays: scope.historyLookbackDays,
    sentLookbackDays: scope.sentLookbackDays,
    cancelledLookbackDays: scope.cancelledLookbackDays,
    queueIndexInitialized: index.initialized,
    queueIndexOrderCount: index.orderCount,
    lastQueueSyncAt: index.lastSyncAt,
    lastQueueSyncError: index.lastError,
    lastTerminalSyncAt: index.lastTerminalSyncAt,
    lastTerminalSyncError: index.lastTerminalError,
    queueSchedulerStarted: isBaseLinkerQueueSchedulerStarted(),
    queueRefreshMs: INDEX_REFRESH_MS,
    terminalQueueRefreshMs: TERMINAL_INDEX_REFRESH_MS,
  });
}));

router.post('/sync', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  const result = await syncBaseLinkerOrderIndex({ force: true });
  res.json({ ...result, syncedAt: new Date().toISOString() });
}));

router.get('/meta', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  res.set('Cache-Control', 'no-store');
  const meta = await fetchBaseLinkerOrderMeta();
  res.json(meta);
}));

router.get('/orders', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');

  const exactOrderId = String(req.query.orderId || '').trim();
  let result;

  if (exactOrderId) {
    // Exact reads stay live. Claim/pack/reconciliation depend on current
    // BaseLinker truth and must never be satisfied only from a local projection.
    result = await fetchBaseLinkerOrders({
      orderId: exactOrderId,
      includeUnconfirmed: true,
      maxPages: 1,
    });
    if (!(result.orders || []).length) {
      const localOrder = await getLocalOrderProjection(exactOrderId);
      if (localOrder) result = { ...result, orders: [localOrder] };
    }
  } else {
    // Numbered pagination is backed by a minimal Intake order_id index. Full
    // BaseLinker order payloads are never persisted; untouched Intake rows are
    // read live for the selected page and local workflow rows come from PickingOrder.
    result = await getIndexedOrderPage({
      statusId: req.query.statusId,
      workflowFilter: req.query.workflowFilter,
      packedBy: req.query.packedBy,
      search: req.query.search,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
  }

  // getOrders intentionally contains order-line data, not full catalog
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
  res.json({ ...result, fetchedAt: new Date().toISOString() });
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
