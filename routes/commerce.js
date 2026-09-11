'use strict';

const express = require('express');
const { asyncHandler } = require('../utils/errors');
const { requireMarketplaceWarehouseAccess } = require('../utils/marketplaceWarehouseAccess');
const { getCommerceIntegrationRegistry } = require('../services/commerce/integrationRegistry');
const { getCommerceProviderRegistry, executeProviderOperation } = require('../services/commerce/providers/registry');
const { previewPublication } = require('../services/commerce/publicationPreview');
const { resolveAllegroMapping, saveAllegroMapping } = require('../services/commerce/allegroMapping');
const { createAllegroDraft, refreshAllegroDraft } = require('../services/commerce/allegroDraftOffer');
const { reconcileAllegroDraft } = require('../services/commerce/allegroDraftReconciliation');
const { resolveAllegroSalesSettings, saveAllegroSalesSettings } = require('../services/commerce/allegroSalesSettings');
const { applyAllegroSalesSettings, refreshAllegroSalesSettingsApply } = require('../services/commerce/allegroSalesSettingsApply');
const { activateAllegroOffer } = require('../services/commerce/allegroActivation');
const { previewAllegroOfferUpdate } = require('../services/commerce/allegroOfferUpdatePreview');
const { applyAllegroOfferContent } = require('../services/commerce/allegroOfferContentUpdate');
const { previewAllegroPriceSync, applyAllegroPriceSync } = require('../services/commerce/allegroPriceSync');
const { previewAllegroStockSync } = require('../services/commerce/allegroStockSync');
const { applyAllegroStockSync } = require('../services/commerce/allegroStockSyncApply');
const { lifecyclePreview, manageAllegroLifecycle } = require('../services/commerce/allegroLifecycle');
const { scanAllegroListingHealth } = require('../services/commerce/allegroListingHealth');
const { listCategories, createCategory, updateCategory } = require('../services/commerce/categories');
const {
  listCatalog,
  getCatalogProduct,
  createCatalogProduct,
  updateCatalogProduct,
  listWarehouseProducts,
  importWarehouseProducts,
} = require('../services/commerce/catalog');

const router = express.Router();

router.use(requireMarketplaceWarehouseAccess);

router.get('/integrations', asyncHandler(async (_req, res) => {
  const registry = await getCommerceIntegrationRegistry();
  res.set('Cache-Control', 'no-store');
  res.json(registry);
}));

router.get('/providers', asyncHandler(async (_req, res) => {
  const registry = await getCommerceProviderRegistry();
  res.set('Cache-Control', 'no-store');
  res.json(registry);
}));

// Provider Core v1: one provider-neutral dispatch surface. Provider-specific
// routes below remain compatibility aliases while the UI migrates, but adding a
// new marketplace no longer requires adding routes to Commerce Core.
router.post('/providers/:provider/operations/:operation', asyncHandler(async (req, res) => {
  const execution = await executeProviderOperation(req.params.provider, req.params.operation, req.body || {});
  res.set('Cache-Control', 'no-store');
  res.status(execution.httpStatus).json(execution.result);
}));


router.post('/publications/preview', asyncHandler(async (req, res) => {
  const result = await previewPublication(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/publications/allegro/mapping/resolve', asyncHandler(async (req, res) => {
  const result = await resolveAllegroMapping(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.put('/publications/allegro/mapping', asyncHandler(async (req, res) => {
  const result = await saveAllegroMapping(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/publications/allegro/drafts', asyncHandler(async (req, res) => {
  const result = await createAllegroDraft(req.body || {});
  res.set('Cache-Control', 'no-store');
  const status = result.state === 'confirmed' ? ((result.alreadyBound || result.recovered) ? 200 : 201) : 202;
  res.status(status).json(result);
}));

router.post('/publications/allegro/drafts/status', asyncHandler(async (req, res) => {
  const result = await refreshAllegroDraft(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.status(result.state === 'confirmed' ? 200 : 202).json(result);
}));

router.post('/publications/allegro/drafts/reconcile', asyncHandler(async (req, res) => {
  const result = await reconcileAllegroDraft(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/publications/allegro/sales-settings/resolve', asyncHandler(async (req, res) => {
  const result = await resolveAllegroSalesSettings(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.put('/publications/allegro/sales-settings', asyncHandler(async (req, res) => {
  const result = await saveAllegroSalesSettings(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/publications/allegro/sales-settings/apply', asyncHandler(async (req, res) => {
  const result = await applyAllegroSalesSettings(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.status(result.state === 'confirmed' ? 200 : 202).json(result);
}));

router.post('/publications/allegro/sales-settings/status', asyncHandler(async (req, res) => {
  const result = await refreshAllegroSalesSettingsApply(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.status(result.state === 'confirmed' ? 200 : 202).json(result);
}));

// Stage 3D.3: one business command owns both activation and recovery/polling.
// Upstream it uses only PATCH product-offer { publication: { status: 'ACTIVE' } }.
router.post('/publications/allegro/activate', asyncHandler(async (req, res) => {
  const result = await activateAllegroOffer(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.status(result.state === 'confirmed' ? 200 : 202).json(result);
}));

// Stage 3D.4A: read-only diff for an existing ACTIVE offer. Price/stock are
// deliberately deferred to dedicated sync stages; no upstream write happens here.
router.post('/publications/allegro/update-preview', asyncHandler(async (req, res) => {
  const result = await previewAllegroOfferUpdate(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

// Stage 3D.4.1: one business command applies only the safe content patch from a
// fresh preview. The same endpoint also polls/reconciles any durable async job.
router.post('/publications/allegro/update-content', asyncHandler(async (req, res) => {
  const result = await applyAllegroOfferContent(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.status(result.state === 'confirmed' ? 200 : 202).json(result);
}));

// Stage 3D.5: price sync uses Allegro's dedicated bulk price/stock command
// contract. Preview is read-only; apply batches up to 25 distinct FIXED prices per
// client-generated commandId and the same business command also polls/reconciles jobs.
router.post('/publications/allegro/price-sync/preview', asyncHandler(async (req, res) => {
  const result = await previewAllegroPriceSync(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/publications/allegro/price-sync', asyncHandler(async (req, res) => {
  const result = await applyAllegroPriceSync(req.body || {});
  res.set('Cache-Control', 'no-store');
  const pending = result.jobs?.some?.((job) => ['reserved', 'sending', 'pending', 'unknown'].includes(job.state));
  res.status(pending ? 202 : 200).json(result);
}));

// Stage 3D.6C: stock remains sourced only from the separate Commerce Inventory
// minus provider-neutral reservations/movements. Preview is read-only; apply owns
// durable beta bulk commands, polling/recovery and explicit zero-stock confirmation.
router.post('/publications/allegro/stock-sync/preview', asyncHandler(async (req, res) => {
  const result = await previewAllegroStockSync(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/publications/allegro/stock-sync', asyncHandler(async (req, res) => {
  const result = await applyAllegroStockSync(req.body || {});
  res.set('Cache-Control', 'no-store');
  const pending = result.jobs?.some?.((job) => ['reserved', 'sending', 'pending', 'unknown'].includes(job.state));
  res.status(pending ? 202 : 200).json(result);
}));

// Stage 3D.7A: lifecycle is explicit and separate from stock sync. Reopen uses
// Allegro's publication command contract; ENDED+zero/stale stock is prepared first
// with the stable quantity-change command, then ACTIVATE is submitted.
router.post('/publications/allegro/lifecycle/preview', asyncHandler(async (req, res) => {
  const result = await lifecyclePreview(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/publications/allegro/lifecycle', asyncHandler(async (req, res) => {
  const result = await manageAllegroLifecycle(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.status(['pending', 'sending', 'unknown'].includes(result.state) ? 202 : 200).json(result);
}));

// Stage 3D.7B: final read-only upstream health/reconciliation. It compares live
// Allegro state with our CommerceProduct/ChannelListing, price, stock, sales
// settings and lifecycle, and annotates recent offer-events as diagnostics.
router.post('/publications/allegro/health', asyncHandler(async (req, res) => {
  const result = await scanAllegroListingHealth(req.body || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.get('/categories', asyncHandler(async (req, res) => {
  const categories = await listCategories({ includeArchived: String(req.query.includeArchived || '') === 'true' });
  res.json({ items: categories });
}));

router.post('/categories', asyncHandler(async (req, res) => {
  const category = await createCategory(req.body || {});
  res.status(201).json(category);
}));

router.patch('/categories/:id', asyncHandler(async (req, res) => {
  const category = await updateCategory(req.params.id, req.body || {});
  res.json(category);
}));

router.get('/catalog', asyncHandler(async (req, res) => {
  const result = await listCatalog(req.query || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.get('/catalog/warehouse-products', asyncHandler(async (req, res) => {
  const result = await listWarehouseProducts(req.query || {});
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/catalog/import-warehouse', asyncHandler(async (req, res) => {
  const result = await importWarehouseProducts(req.body || {}, req);
  res.status(result.createdCount > 0 ? 201 : 200).json(result);
}));

router.post('/catalog', asyncHandler(async (req, res) => {
  const product = await createCatalogProduct(req.body || {}, req);
  res.status(201).json(product);
}));

router.get('/catalog/:id', asyncHandler(async (req, res) => {
  const product = await getCatalogProduct(req.params.id);
  res.set('Cache-Control', 'no-store');
  res.json(product);
}));

router.patch('/catalog/:id', asyncHandler(async (req, res) => {
  const product = await updateCatalogProduct(req.params.id, req.body || {}, req);
  res.json(product);
}));

module.exports = router;
