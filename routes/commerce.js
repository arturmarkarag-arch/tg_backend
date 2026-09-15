'use strict';

const express = require('express');
const { asyncHandler } = require('../utils/errors');
const { requireMarketplaceWarehouseAccess } = require('../utils/marketplaceWarehouseAccess');
const { getCommerceIntegrationRegistry } = require('../services/commerce/integrationRegistry');
const { getCommerceProviderRegistry, executeProviderOperation } = require('../services/commerce/providers/registry');
const { previewPublication } = require('../services/commerce/publicationPreview');
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

// Legacy Allegro publication URLs are compatibility aliases only. They dispatch
// through the Provider Registry exactly like /providers/:provider/operations/:operation;
// no provider implementation service is reachable from Commerce Core routes.
function legacyPublicationOperation(operationId) {
  return asyncHandler(async (req, res) => {
    const execution = await executeProviderOperation('allegro', operationId, req.body || {});
    res.set('Cache-Control', 'no-store');
    res.status(execution.httpStatus).json(execution.result);
  });
}

router.post('/publications/allegro/mapping/resolve', legacyPublicationOperation('mapping.resolve'));
router.put('/publications/allegro/mapping', legacyPublicationOperation('mapping.save'));
router.post('/publications/allegro/drafts', legacyPublicationOperation('draft.create'));
router.post('/publications/allegro/drafts/status', legacyPublicationOperation('draft.refresh'));
router.post('/publications/allegro/drafts/reconcile', legacyPublicationOperation('draft.reconcile'));
router.post('/publications/allegro/sales-settings/resolve', legacyPublicationOperation('sales-settings.resolve'));
router.put('/publications/allegro/sales-settings', legacyPublicationOperation('sales-settings.save'));
router.post('/publications/allegro/sales-settings/apply', legacyPublicationOperation('sales-settings.apply'));
router.post('/publications/allegro/sales-settings/status', legacyPublicationOperation('sales-settings.refresh'));
router.post('/publications/allegro/activate', legacyPublicationOperation('listing.activate'));
router.post('/publications/allegro/update-preview', legacyPublicationOperation('content.preview'));
router.post('/publications/allegro/update-content', legacyPublicationOperation('content.apply'));
router.post('/publications/allegro/price-sync/preview', legacyPublicationOperation('price.preview'));
router.post('/publications/allegro/price-sync', legacyPublicationOperation('price.apply'));
router.post('/publications/allegro/stock-sync/preview', legacyPublicationOperation('stock.preview'));
router.post('/publications/allegro/stock-sync', legacyPublicationOperation('stock.apply'));
router.post('/publications/allegro/lifecycle/preview', legacyPublicationOperation('lifecycle.preview'));
router.post('/publications/allegro/lifecycle', legacyPublicationOperation('lifecycle.apply'));
router.post('/publications/allegro/health', legacyPublicationOperation('health.scan'));

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
