'use strict';

const express = require('express');
const { asyncHandler } = require('../utils/errors');
const { requireMarketplaceWarehouseAccess } = require('../utils/marketplaceWarehouseAccess');
const { getCommerceIntegrationRegistry } = require('../services/commerce/integrationRegistry');
const { previewPublication } = require('../services/commerce/publicationPreview');
const { resolveAllegroMapping, saveAllegroMapping } = require('../services/commerce/allegroMapping');
const { createAllegroDraft, refreshAllegroDraft } = require('../services/commerce/allegroDraftOffer');
const { reconcileAllegroDraft } = require('../services/commerce/allegroDraftReconciliation');
const { resolveAllegroSalesSettings, saveAllegroSalesSettings } = require('../services/commerce/allegroSalesSettings');
const { applyAllegroSalesSettings, refreshAllegroSalesSettingsApply } = require('../services/commerce/allegroSalesSettingsApply');
const { activateAllegroOffer } = require('../services/commerce/allegroActivation');
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
