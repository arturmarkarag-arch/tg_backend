'use strict';

const express = require('express');
const { requireTelegramRole } = require('../middleware/telegramAuth');
const { requireBaseLinkerPickingAccess } = require('../utils/baseLinkerAccess');
const { asyncHandler, appError } = require('../utils/errors');
const { getPrintAgentStatus, queuePrintJob } = require('../services/baseLinkerPrint');
const {
  getIndexedOrderPage,
  getLocalOrderProjection,
  loadIndexState,
  syncBaseLinkerOrderIndex,
  INDEX_REFRESH_MS,
} = require('../services/baseLinkerOrderIndex');
const { isBaseLinkerQueueSchedulerStarted } = require('../services/baseLinkerQueueScheduler');
const { getQueueScope } = require('../services/baseLinkerQueueScope');
const { fetchBaseLinkerProductCatalog, getOrdersWithCachedProductImages, attachProductImagesToOrders } = require('../services/baseLinkerProducts');
const { compactOrders } = require('../services/baseLinkerPublicDto');
const { orderKey } = require('../services/baseLinkerIdentity');
const { makeBaseLinkerAccountCaller, getBaseLinkerApiUsage } = require('../services/baseLinkerClient');
const { listBaseLinkerAccounts, getBaseLinkerAccount } = require('../services/baseLinkerAccounts');
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
  assertBaseLinkerPrintAllowed,
  assertBaseLinkerPrintAllowedCached,
  markPickingOrderPacked,
  markPickingOrderSent,
  reopenPickingOrder,
  acknowledgeUpstreamReview,
} = require('../services/baseLinkerPicking');

const router = express.Router();
router.use(requireBaseLinkerPickingAccess);

async function resolveAccountId(req, { requireEnabled = false } = {}) {
  const accountId = String(req.params?.accountId || req.query?.accountId || req.body?.baseLinkerAccountId || req.body?.accountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  await getBaseLinkerAccount(accountId, { requireEnabled, lean: true });
  return accountId;
}

function callerFor(accountId, { requireEnabled = true, usageStage = 'other' } = {}) {
  return makeBaseLinkerAccountCaller(accountId, { requireEnabled, usageStage });
}

async function publicAccountRuntime(account) {
  const scope = await getQueueScope(account.accountId);
  const index = await loadIndexState(account.accountId, scope);
  return {
    ...account,
    queueConfigured: scope.configured,
    queue: {
      intakeStatusId: scope.intakeStatusId,
      intakeStatusName: scope.intakeStatusName,
      sentStatusId: scope.sentStatusId,
      sentStatusName: scope.sentStatusName,
      cancelledStatusId: scope.cancelledStatusId,
      cancelledStatusName: scope.cancelledStatusName,
    },
    historyRetentionDays: scope.historyRetentionDays,
    queueIndexInitialized: index.initialized,
    queueIndexOrderCount: index.orderCount,
    lastQueueSyncAt: index.lastSyncAt,
    lastQueueSyncError: index.lastError,
  };
}

router.get('/status', asyncHandler(async (_req, res) => {
  const accounts = await listBaseLinkerAccounts({ includeDisabled: true });
  const runtime = [];
  for (const account of accounts) runtime.push(await publicAccountRuntime(account));
  res.json({
    configured: accounts.length > 0,
    accounts: runtime,
    queueSchedulerStarted: isBaseLinkerQueueSchedulerStarted(),
    queueRefreshMs: INDEX_REFRESH_MS,
  });
}));

router.get('/api-usage', requireTelegramRole('admin'), asyncHandler(async (_req, res) => {
  const accounts = await listBaseLinkerAccounts({ includeDisabled: true });
  const usage = await getBaseLinkerApiUsage(accounts.map((account) => account.accountId));
  const nameById = new Map(accounts.map((account) => [String(account.accountId), String(account.name || account.accountId)]));
  res.set('Cache-Control', 'no-store');
  res.json({
    ...usage,
    accounts: usage.accounts.map((row) => ({ ...row, accountName: nameById.get(String(row.baseLinkerAccountId)) || row.baseLinkerAccountId })),
  });
}));

router.post('/sync', requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const accountId = String(req.body?.accountId || req.body?.baseLinkerAccountId || '').trim();
  if (accountId) await getBaseLinkerAccount(accountId, { requireEnabled: true, lean: true });
  const result = await syncBaseLinkerOrderIndex({ accountId, force: true });
  res.json({ ...result, syncedAt: new Date().toISOString() });
}));

router.get('/meta', asyncHandler(async (_req, res) => {
  const accounts = await listBaseLinkerAccounts({ includeDisabled: true });
  const result = [];
  for (const account of accounts) {
    // Ordinary worker reads never refresh BaseLinker metadata. Admin settings
    // owns explicit metadata refresh; every worker only reads the durable snapshot.
    const metadata = account.metadataSnapshot || {};
    const metadataError = String(account.connectionError || '');
    result.push({
      accountId: account.accountId,
      name: account.name,
      color: account.color || '',
      enabled: account.enabled === true,
      statuses: Array.isArray(metadata?.statuses) ? metadata.statuses : [],
      sources: metadata?.sources && typeof metadata.sources === 'object' ? metadata.sources : {},
      inventories: Array.isArray(metadata?.inventories) ? metadata.inventories : [],
      metadataFetchedAt: account.metadataFetchedAt || null,
      metadataError,
    });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ accounts: result, fetchedAt: new Date().toISOString() });
}));

async function sendOrdersPayload(res, result, { allowUpstreamCatalog = false } = {}) {
  const inputOrders = Array.isArray(result?.orders) ? result.orders : [];
  let imageState;

  if (allowUpstreamCatalog) {
    try {
      const catalog = await fetchBaseLinkerProductCatalog(inputOrders);
      imageState = {
        orders: attachProductImagesToOrders(inputOrders, catalog.productCatalog || {}),
        productCatalogStats: catalog.productCatalogStats,
        productCatalogWarnings: catalog.productCatalogWarnings || [],
      };
    } catch (error) {
      imageState = {
        orders: inputOrders,
        productCatalogStats: { requested: 0, resolved: 0, unresolved: 0, warnings: 1 },
        productCatalogWarnings: [{ scope: 'catalog', code: error?.code || error?.message || 'catalog_lookup_failed' }],
      };
    }
  } else {
    imageState = await getOrdersWithCachedProductImages(inputOrders);
  }

  const refs = imageState.orders.map((order) => ({
    baseLinkerAccountId: order?.baseLinkerAccountId,
    orderId: order?.order_id,
  }));
  const pickingStates = await getPickingStates(refs);
  const {
    productCatalog: _legacyCatalog,
    productCatalogStats: _legacyCatalogStats,
    productCatalogWarnings: _legacyCatalogWarnings,
    ...publicResult
  } = result || {};

  res.json({
    ...publicResult,
    orders: compactOrders(imageState.orders),
    productCatalogStats: imageState.productCatalogStats || { requested: 0, resolved: 0, unresolved: 0, warnings: 0 },
    productCatalogWarnings: imageState.productCatalogWarnings || [],
    pickingStates,
    fetchedAt: new Date().toISOString(),
  });
}

async function ordersHandler(req, res) {
  if (req.query.orderId !== undefined) throw appError('baselinker_exact_order_requires_account_path');
  const requestedAccountId = String(req.query.accountId || '').trim();
  if (requestedAccountId) await getBaseLinkerAccount(requestedAccountId, { lean: true });
  const result = await getIndexedOrderPage({
    accountId: requestedAccountId,
    sourceAccountId: req.query.sourceAccountId,
    sourceType: req.query.sourceType,
    sourceId: req.query.sourceId,
    workflowFilter: req.query.workflowFilter,
    sentBy: req.query.sentBy,
    search: req.query.search,
    page: req.query.page,
    pageSize: req.query.pageSize,
  });
  return sendOrdersPayload(res, result);
}

async function exactOrderHandler(req, res) {
  const accountId = await resolveAccountId(req, { requireEnabled: true });
  const exactOrderId = String(req.params.orderId || '').trim();
  // Worker detail reads are Mongo-only. Critical mutations perform their own
  // exact BaseLinker verification; opening an active order must consume zero
  // upstream request budget even with hundreds of concurrent workers.
  const localOrder = await getLocalOrderProjection(accountId, exactOrderId);
  const result = { orders: localOrder ? [localOrder] : [] };
  return sendOrdersPayload(res, result);
}

router.get('/orders', asyncHandler(ordersHandler));
router.get('/accounts/:accountId/orders/:orderId', asyncHandler(exactOrderHandler));

async function cachedShipmentForRequest(accountId, orderId) {
  const order = await getLocalOrderProjection(accountId, orderId);
  if (!order) throw appError('baselinker_order_status_unverified', { orderId: String(orderId || '') });
  const packageNumber = String(order?.delivery_package_nr || '').trim();
  const courierCode = String(order?.delivery_package_module || '').trim();
  if (!packageNumber) throw appError('baselinker_package_number_invalid');
  if (!courierCode) throw appError('baselinker_courier_code_invalid');
  return { order, packageNumber, courierCode };
}

async function shipmentLabelHandler(req, res) {
  const accountId = await resolveAccountId(req, { requireEnabled: true });
  await assertBaseLinkerPrintAllowedCached({
    baseLinkerAccountId: accountId,
    orderId: req.params.orderId,
    confirmTerminalTtn: String(req.query.confirmTerminalTtn || '') === '1',
    confirmedDisposition: req.query.confirmedDisposition,
  });
  const shipment = await cachedShipmentForRequest(accountId, req.params.orderId);
  const label = await require('../services/baseLinkerShipments').fetchBaseLinkerLabel({
    packageNumber: shipment.packageNumber,
    courierCode: shipment.courierCode,
  }, callerFor(accountId, { usageStage: 'shipment_read' }));
  const safeExtension = /^[a-z0-9]{1,8}$/.test(label.extension) ? label.extension : 'bin';
  res.set({
    'Content-Type': label.contentType,
    'Content-Length': String(label.buffer.length),
    'Content-Disposition': `inline; filename="baselinker-label-${accountId}-${shipment.packageNumber}.${safeExtension}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-BaseLinker-Account-Id': accountId,
    'X-BaseLinker-Label-Extension': safeExtension,
  });
  res.send(label.buffer);
}

async function shipmentPrintHandler(req, res) {
  const accountId = await resolveAccountId(req, { requireEnabled: true });
  const job = await queuePrintJob({
    baseLinkerAccountId: accountId,
    orderId: req.params.orderId,
    confirmTerminalTtn: req.body?.confirmTerminalTtn === true,
    confirmedDisposition: req.body?.confirmedDisposition,
    user: req.telegramUser,
  });
  res.status(202).json({ job });
}

async function packagesHandler(req, res) {
  const accountId = await resolveAccountId(req, { requireEnabled: true });
  const result = await fetchBaseLinkerOrderPackages(req.params.orderId, callerFor(accountId, { usageStage: 'shipment_read' }));
  res.json({ ...result, baseLinkerAccountId: accountId, fetchedAt: new Date().toISOString() });
}
async function packageDetailsHandler(req, res) {
  const accountId = await resolveAccountId(req, { requireEnabled: true });
  const result = await fetchVerifiedBaseLinkerOrderPackage({
    orderId: req.params.orderId,
    packageId: req.params.packageId,
    courierCode: req.query.courierCode,
  }, callerFor(accountId, { usageStage: 'shipment_read' }));
  res.json({ ...result, baseLinkerAccountId: accountId, fetchedAt: new Date().toISOString() });
}
async function labelHandler(req, res) {
  const accountId = await resolveAccountId(req, { requireEnabled: true });
  await assertBaseLinkerPrintAllowed({
    baseLinkerAccountId: accountId,
    orderId: req.params.orderId,
    confirmTerminalTtn: String(req.query.confirmTerminalTtn || '') === '1',
    confirmedDisposition: req.query.confirmedDisposition,
  });
  const label = await fetchVerifiedBaseLinkerOrderLabel({
    orderId: req.params.orderId,
    packageId: req.params.packageId,
    courierCode: req.query.courierCode,
  }, callerFor(accountId, { usageStage: 'shipment_read' }));
  const safeExtension = /^[a-z0-9]{1,8}$/.test(label.extension) ? label.extension : 'bin';
  res.set({
    'Content-Type': label.contentType,
    'Content-Length': String(label.buffer.length),
    'Content-Disposition': `inline; filename="baselinker-label-${accountId}-${label.packageId}.${safeExtension}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-BaseLinker-Account-Id': accountId,
    'X-BaseLinker-Label-Extension': safeExtension,
  });
  res.send(label.buffer);
}
async function printHandler(req, res) {
  const accountId = await resolveAccountId(req, { requireEnabled: true });
  const job = await queuePrintJob({
    baseLinkerAccountId: accountId,
    orderId: req.params.orderId,
    packageId: req.params.packageId,
    courierCode: req.body?.courierCode,
    confirmTerminalTtn: req.body?.confirmTerminalTtn === true,
    confirmedDisposition: req.body?.confirmedDisposition,
    user: req.telegramUser,
  });
  res.status(202).json({ job });
}

// Canonical greenfield multi-account paths. accountId is mandatory.
router.get('/accounts/:accountId/orders/:orderId/shipment/label', asyncHandler(shipmentLabelHandler));
router.post('/accounts/:accountId/orders/:orderId/shipment/print', asyncHandler(shipmentPrintHandler));
router.get('/accounts/:accountId/orders/:orderId/packages', asyncHandler(packagesHandler));
router.get('/accounts/:accountId/orders/:orderId/packages/:packageId/details', asyncHandler(packageDetailsHandler));
router.get('/accounts/:accountId/orders/:orderId/packages/:packageId/label', asyncHandler(labelHandler));
router.post('/accounts/:accountId/orders/:orderId/packages/:packageId/print', asyncHandler(printHandler));

router.get('/print-agent/status', asyncHandler(async (_req, res) => {
  res.json(await getPrintAgentStatus());
}));

function clientMutationIdFromRequest(req) {
  return String(req.body?.clientMutationId || '').trim().slice(0, 160);
}

async function pickingStateHandler(req, res) {
  const accountId = await resolveAccountId(req);
  const key = orderKey(accountId, req.params.orderId);
  const states = await getPickingStates([{ baseLinkerAccountId: accountId, orderId: req.params.orderId }]);
  res.json({ state: states[key] || null });
}

function pickingMutation(action, { adminOnly = false } = {}) {
  const middleware = [];
  if (adminOnly) middleware.push(requireTelegramRole('admin'));
  middleware.push(asyncHandler(async (req, res) => {
    const accountId = await resolveAccountId(req, { requireEnabled: true });
    const clientMutationId = clientMutationIdFromRequest(req);
    const common = {
      baseLinkerAccountId: accountId,
      orderId: req.params.orderId,
      user: req.telegramUser,
      expectedRevision: req.body?.expectedRevision,
      clientMutationId,
    };
    let payload;
    switch (action) {
      case 'claim': payload = await claimPickingOrder({ ...common, force: req.body?.force === true }); break;
      case 'heartbeat': payload = await heartbeatPickingOrder(common); break;
      case 'release': payload = { state: await releasePickingOrder({ ...common, force: req.body?.force === true }) }; break;
      case 'packed': payload = await markPickingOrderPacked(common); break;
      case 'sent': payload = await markPickingOrderSent(common); break;
      case 'reviewed': payload = { state: await acknowledgeUpstreamReview(common) }; break;
      case 'reopen': payload = { state: await reopenPickingOrder(common) }; break;
      default: throw appError('validation_failed');
    }
    res.json({ ...payload, ...(clientMutationId ? { clientMutationId } : {}) });
  }));
  return middleware;
}

async function updateItemHandler(req, res) {
  const accountId = await resolveAccountId(req, { requireEnabled: true });
  const clientMutationId = clientMutationIdFromRequest(req);
  const state = await updatePickingItem({
    baseLinkerAccountId: accountId,
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
}

router.get('/picking/my-active', asyncHandler(async (req, res) => {
  res.json({ state: await getMyActivePicking(req.telegramUser) });
}));

const pickingPrefix = '/accounts/:accountId/picking/orders/:orderId';
router.get(pickingPrefix, asyncHandler(pickingStateHandler));
router.post(`${pickingPrefix}/claim`, ...pickingMutation('claim'));
router.post(`${pickingPrefix}/heartbeat`, ...pickingMutation('heartbeat'));
router.patch(`${pickingPrefix}/items/:lineKey`, asyncHandler(updateItemHandler));
router.post(`${pickingPrefix}/release`, ...pickingMutation('release'));
router.post(`${pickingPrefix}/packed`, ...pickingMutation('packed'));
router.post(`${pickingPrefix}/sent`, ...pickingMutation('sent'));
router.post(`${pickingPrefix}/upstream-reviewed`, ...pickingMutation('reviewed'));
router.post(`${pickingPrefix}/reopen`, ...pickingMutation('reopen', { adminOnly: true }));

module.exports = router;
