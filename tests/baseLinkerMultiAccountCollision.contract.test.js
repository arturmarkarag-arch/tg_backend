const fs = require('fs');
const path = require('path');
const { orderKey, sourceKey, productKey, resolveSourceName, annotateOrder } = require('../services/baseLinkerIdentity');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('BaseLinker multi-account collision contract', () => {
  it('treats the same order_id from two BaseLinker accounts as two different orders', () => {
    expect(orderKey('account-A', 123)).toBe('account-A:123');
    expect(orderKey('account-B', 123)).toBe('account-B:123');
    expect(orderKey('account-A', 123)).not.toBe(orderKey('account-B', 123));

    const a = annotateOrder({ order_id: 123, order_source: 'allegro', order_source_id: 7 }, { accountId: 'account-A', name: 'A' });
    const b = annotateOrder({ order_id: 123, order_source: 'allegro', order_source_id: 7 }, { accountId: 'account-B', name: 'B' });
    expect(a.orderKey).toBe('account-A:123');
    expect(b.orderKey).toBe('account-B:123');
  });

  it('uses the documented generic order_return source name without weakening exact source identity', () => {
    const sources = { order_return: ['Order return'] };
    expect(resolveSourceName(sources, 'order_return', 98765)).toBe('Order return');
    expect(sourceKey('account-A', 'order_return', 98765)).toBe('account-A:order_return:98765');
  });

  it('namespaces source identity by account and source type', () => {
    const aAllegro = sourceKey('account-A', 'allegro', 150);
    const aAmazon = sourceKey('account-A', 'amazon', 150);
    const bAllegro = sourceKey('account-B', 'allegro', 150);
    expect(new Set([aAllegro, aAmazon, bAllegro]).size).toBe(3);
  });

  it('namespaces identical catalog ids by account', () => {
    const product = { storage: 'db', storage_id: 307, product_id: 2685 };
    expect(productKey('account-A', product)).toBe('account-A:db:307:2685');
    expect(productKey('account-B', product)).toBe('account-B:db:307:2685');
  });

  it('uses composite Mongo indexes and queries for orders/picking', () => {
    const orderIndex = read('models/BaseLinkerOrderIndex.js');
    const pickingModel = read('models/BaseLinkerPickingOrder.js');
    const picking = read('services/baseLinkerPicking.js');

    expect(orderIndex).toContain('index({ baseLinkerAccountId: 1, orderId: 1 }, { unique: true })');
    expect(pickingModel).toContain('index({ baseLinkerAccountId: 1, orderId: 1 }, { unique: true })');
    expect(orderIndex).not.toContain('index({ orderId: 1 }, { unique: true })');
    expect(pickingModel).not.toContain('index({ orderId: 1 }, { unique: true })');
    expect(picking).toContain('{ baseLinkerAccountId: accountId, orderId: requestedId }');
    expect(picking).toContain('withLock(`baselinker-order:${accountId}:${requestedId}`');
  });

  it('namespaces package/print lookup by account and concrete order', () => {
    const printModel = read('models/BaseLinkerPrintJob.js');
    const printService = read('services/baseLinkerPrint.js');
    const routes = read('routes/baseLinker.js');

    expect(printModel).toContain('baseLinkerAccountId: { type: String, required: true');
    expect(printModel).toContain('index({ baseLinkerAccountId: 1, packageId: 1, status: 1');
    expect(printService).toContain('baseLinkerAccountId');
    expect(routes).toContain("/accounts/:accountId/orders/:orderId/packages/:packageId/print");
  });

  it('has no concrete order mutation/read route that can omit accountId', () => {
    const routes = read('routes/baseLinker.js');
    expect(routes).toContain("const pickingPrefix = '/accounts/:accountId/picking/orders/:orderId'");
    expect(routes).toContain("router.get('/accounts/:accountId/orders/:orderId', asyncHandler(exactOrderHandler))");
    expect(routes).toContain("router.get('/accounts/:accountId/orders/:orderId/packages'");
    expect(routes).toContain('baselinker_exact_order_requires_account_path');
    const literalOrderRoutes = [...routes.matchAll(/router\.(?:get|post|patch|delete)\('([^']*:orderId[^']*)'/g)]
      .map((match) => match[1]);
    expect(literalOrderRoutes.length).toBeGreaterThan(0);
    expect(literalOrderRoutes.every((route) => route.includes(':accountId'))).toBe(true);
  });
});
