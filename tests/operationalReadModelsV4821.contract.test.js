'use strict';

const fs = require('fs');
const path = require('path');
const { sliceBetweenOrThrow } = require('./helpers/sourceContract');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const READ_MODEL_FILES = [
  'services/readModels/currentShopTopologyReadModel.js',
  'services/readModels/currentSessionShopStatusReadModel.js',
  'services/readModels/deliveryGroupShopStatusReadModel.js',
  'services/readModels/sellerOrderingStatusReadModel.js',
  'services/readModels/currentSessionShopProductsReadModel.js',
  'services/readModels/deliveryGroupCatalogReadModel.js',
  'services/readModels/deliveryGroupSessionSummaryReadModel.js',
];

describe('V48.21 operational read-model architecture contract', () => {
  it('deliveryGroups GET endpoints are transport-only facades over named read models', () => {
    const route = read('routes/deliveryGroups.js');
    const checks = [
      ["router.get('/ordering-status'", "router.post('/catalog-reviewed'", 'buildSellerOrderingStatusReadModel(req.telegramUser)'],
      ["router.get('/summary'", "/**\n * GET /api/delivery-groups/:groupId/shop-status", 'buildDeliveryGroupSummaryReadModel()'],
      ["router.get('/:groupId/shop-status'", '/**\n * GET /api/delivery-groups/:groupId/shops/:shopId/ordered-products', 'buildDeliveryGroupShopStatusReadModel({'],
      ["router.get('/:groupId/shops/:shopId/ordered-products'", "router.get('/session-summaries'", 'buildCurrentSessionShopProductsReadModel({'],
      ["router.get('/session-summaries'", "router.post('/:id/close-ordering-session'", 'buildDeliveryGroupSessionSummariesReadModel()'],
      ["router.get('/',", "router.post('/',", 'buildDeliveryGroupListReadModel()'],
    ];
    for (const [start, end, delegate] of checks) {
      const block = sliceBetweenOrThrow(route, start, end, { label: `read facade ${start}` });
      expect(block).toContain(delegate);
      expect(block).not.toMatch(/\b(?:User|Order|Shop|Product|PickingTask|CatalogReview|OrderingSession)\.(?:find|findOne|aggregate|countDocuments|exists)\(/);
    }
  });

  it('read-model modules cannot perform domain writes or materialise sessions', () => {
    for (const rel of READ_MODEL_FILES) {
      const source = read(rel);
      expect(source, rel).not.toMatch(/\.(?:findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany|create|save)\s*\(/);
      expect(source, rel).not.toContain('startSession(');
      expect(source, rel).not.toContain('withTransaction(');
      expect(source, rel).not.toContain('getOrCreateSessionId(');
    }
  });

  it('readiness is structurally CURRENT-only, with no session/history model imports', () => {
    const source = read('services/readModels/currentShopTopologyReadModel.js');
    expect(source).toContain('buildReadinessShopProjection');
    expect(source).toContain('ASSIGNED_SHOP_ROLES');
    for (const model of ['Order', 'OrderingSession', 'PickingTask', 'CatalogReview']) {
      expect(source).not.toContain(`models/${model}`);
    }
  });

  it('shop-status facade selects one explicit projection and readiness has no session identity', () => {
    const source = read('services/readModels/deliveryGroupShopStatusReadModel.js');
    expect(source).toContain("CURRENT: 'current'");
    expect(source).toContain("READINESS: 'readiness'");
    expect(source).toContain('buildCurrentShopTopologyReadModel(group)');
    expect(source).toContain('buildCurrentSessionShopStatusReadModel(group, { windowOpen: status.isOpen })');
    expect(source).toContain('currentSessionId: null');
  });

  it('current-session projection keeps current assignment and historical participant display separate', () => {
    const source = read('services/readModels/currentSessionShopStatusReadModel.js');
    expect(source).toContain('currentAssignedUsers');
    expect(source).toContain('sessionParticipants');
    expect(source).toContain('buildCurrentSessionShopProjection({');
    expect(source).toContain('assignedUsers: currentAssignedUsers');
    expect(source).toContain('sessionParticipants,');
    expect(source).toContain('const reviewMarks = currentSessionId ? await CatalogReview.find(');
  });

  it('top-level and snapshot-only orders resolve to one canonical shop identity inside the projection', () => {
    const source = read('services/readModels/currentSessionShopStatusReadModel.js');
    expect(source).toMatch(/function resolveOrderShopId\(order\)[\s\S]*order\?\.shopId \|\| order\?\.buyerSnapshot\?\.shopId/);
    const uses = source.match(/resolveOrderShopId\(order\)/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('buildOrderedBuyerIdsByShop(orders)');
  });

  it('seller ordering status polling is a pure read using existing session identity', () => {
    const source = read('services/readModels/sellerOrderingStatusReadModel.js');
    expect(source).toContain('findCurrentSessionId(String(group._id), group.orderingSchedule)');
    expect(source).toContain("reason: 'shop_inactive'");
    expect(source).not.toContain('getOrCreateSessionId(');
  });

  it('group selector/list presentation delegates phase to sessionPresentation', () => {
    const source = read('services/readModels/deliveryGroupCatalogReadModel.js');
    expect(source).toContain('getCurrentGroupPresentation(group, { now })');
    expect(source).toContain('presentationMode: presentations[index]?.presentationMode');
    expect(source).toContain('phase: presentations[index]?.phase');
    expect(source).not.toContain('deriveSessionPhase(');
  });

  it('ordered-products disclosure shares the current-session live-line predicate', () => {
    const products = read('services/readModels/currentSessionShopProductsReadModel.js');
    const status = read('services/readModels/currentSessionShopStatusReadModel.js');
    expect(products).toContain("require('./currentSessionShopStatusReadModel')");
    expect(products).toContain('if (!liveItem(item)) continue');
    expect(status).toContain('function liveItem(item)');
  });

  it('session summary read model remains read-only and distinguishes current vs stale by session id', () => {
    const source = read('services/readModels/deliveryGroupSessionSummaryReadModel.js');
    expect(source).toContain('findCurrentSessionId(');
    expect(source).toContain('acc.activeCount += 1');
    expect(source).toContain('acc.staleCount += 1');
    expect(source).not.toContain('getOrCreateSessionId(');
  });
});
