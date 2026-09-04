const express = require('express');
const { requireTelegramRole } = require('../middleware/telegramAuth');
const { requireBaseLinkerPickingAccess } = require('../utils/baseLinkerAccess');
const { asyncHandler, appError } = require('../utils/errors');
const { isBaseLinkerConfigured } = require('../services/baseLinkerClient');
const { getPrintAgentStatus, queuePrintJob } = require('../services/baseLinkerPrint');
const { fetchBaseLinkerOrders, fetchBaseLinkerOrderMeta } = require('../services/baseLinkerOrders');
const { getCachedOrderPage, refreshBaseLinkerOrderCache } = require('../services/baseLinkerOrderCache');
const { fetchBaseLinkerProductCatalog } = require('../services/baseLinkerProducts');
const {
  fetchBaseLinkerOrderPackages,
  fetchBaseLinkerPackageDetails,
  fetchBaseLinkerLabel,
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
} = require('../services/baseLinkerPicking');

const router = express.Router();

// BaseLinker is available only to admins and the dedicated `baselinker` role.
// The boundary is server-side; hiding a navigation item in React is never
// treated as authorization.
router.use(requireBaseLinkerPickingAccess);

router.get('/status', (req, res) => {
  res.json({ configured: isBaseLinkerConfigured() });
});

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
    await refreshBaseLinkerOrderCache({ orders: result.orders || [] });
  } else {
    // The work queue is server-paginated from a dedicated BaseLinker snapshot
    // cache. The browser receives only the requested 10/20/50 logical orders;
    // it no longer downloads/scans the whole account on every page render.
    result = await getCachedOrderPage({
      statusId: req.query.statusId,
      workflowFilter: req.query.workflowFilter,
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
    ...catalog,
    pickingStates,
    fetchedAt: new Date().toISOString(),
  });
}));

router.get('/orders/:orderId/packages', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  const result = await fetchBaseLinkerOrderPackages(req.params.orderId);
  res.json({ ...result, fetchedAt: new Date().toISOString() });
}));

router.get('/packages/:packageId/details', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  const result = await fetchBaseLinkerPackageDetails(req.params.packageId);
  res.json({ ...result, fetchedAt: new Date().toISOString() });
}));

router.get('/packages/:packageId/label', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  const label = await fetchBaseLinkerLabel({
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

router.post('/packages/:packageId/print', asyncHandler(async (req, res) => {
  if (!isBaseLinkerConfigured()) throw appError('baselinker_not_configured');
  const job = await queuePrintJob({
    orderId: req.body?.orderId,
    packageId: req.params.packageId,
    courierCode: req.body?.courierCode,
    user: req.telegramUser,
  });
  res.status(202).json({ job });
}));


// ── Local fulfilment workflow ───────────────────────────────────────────────
// These endpoints mutate ONLY our MongoDB picking state. BaseLinker itself is
// still accessed through read-only `get...` methods; no upstream create/set/
// delete method exists in this router.
router.get('/picking/my-active', asyncHandler(async (req, res) => {
  res.json({ state: await getMyActivePicking(req.telegramUser) });
}));

router.get('/picking/orders/:orderId', asyncHandler(async (req, res) => {
  const states = await getPickingStates([req.params.orderId]);
  res.json({ state: states[String(req.params.orderId)] || null });
}));

router.post('/picking/orders/:orderId/claim', asyncHandler(async (req, res) => {
  const result = await claimPickingOrder({
    orderId: req.params.orderId,
    memberOrderIds: Array.isArray(req.body?.memberOrderIds) ? req.body.memberOrderIds : [],
    user: req.telegramUser,
    force: req.body?.force === true,
  });
  res.json(result);
}));

router.post('/picking/orders/:orderId/heartbeat', asyncHandler(async (req, res) => {
  res.json(await heartbeatPickingOrder({
    orderId: req.params.orderId,
    user: req.telegramUser,
  }));
}));

router.patch('/picking/orders/:orderId/items/:lineKey', asyncHandler(async (req, res) => {
  const state = await updatePickingItem({
    orderId: req.params.orderId,
    lineKey: req.params.lineKey,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
    state: req.body?.state,
    pickedQty: req.body?.pickedQty,
    issueNote: req.body?.issueNote,
  });
  res.json({ state });
}));

router.post('/picking/orders/:orderId/release', asyncHandler(async (req, res) => {
  const state = await releasePickingOrder({
    orderId: req.params.orderId,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
    force: req.body?.force === true,
  });
  res.json({ state });
}));

router.post('/picking/orders/:orderId/packed', asyncHandler(async (req, res) => {
  res.json(await markPickingOrderPacked({
    orderId: req.params.orderId,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
    allowIssues: req.body?.allowIssues === true,
  }));
}));

router.post('/picking/orders/:orderId/sent', asyncHandler(async (req, res) => {
  const state = await markPickingOrderSent({
    orderId: req.params.orderId,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
  });
  res.json({ state });
}));

router.post('/picking/orders/:orderId/reopen', requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const state = await reopenPickingOrder({
    orderId: req.params.orderId,
    user: req.telegramUser,
    expectedRevision: req.body?.expectedRevision,
  });
  res.json({ state });
}));

module.exports = router;
