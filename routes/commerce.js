'use strict';

const express = require('express');
const { asyncHandler } = require('../utils/errors');
const { requireMarketplaceWarehouseAccess } = require('../utils/marketplaceWarehouseAccess');
const { getCommerceIntegrationRegistry } = require('../services/commerce/integrationRegistry');

const router = express.Router();

router.use(requireMarketplaceWarehouseAccess);

router.get('/integrations', asyncHandler(async (_req, res) => {
  const registry = await getCommerceIntegrationRegistry();
  res.set('Cache-Control', 'no-store');
  res.json(registry);
}));

module.exports = router;
