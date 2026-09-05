const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('BaseLinker server-side pagination contract', () => {
  it('uses a dedicated BaseLinker cache instead of returning a maxPages account scan to the browser', () => {
    const route = read('routes/baseLinker.js');
    expect(route).toContain('getCachedOrderPage');
    expect(route).toContain('pageSize: req.query.pageSize');
    expect(route).toContain('workflowFilter: req.query.workflowFilter');
    expect(route).not.toMatch(/maxPages:\s*req\.query\.maxPages/);
  });

  it('projects cached/live orders before sending them to the browser', () => {
    const route = read('routes/baseLinker.js');
    const cache = read('services/baseLinkerOrderCache.js');
    expect(route).toContain('compactOrders(result.orders || [])');
    expect(route).toContain('compactProductCatalog');
    expect(cache).toContain('order: compactOrder(order)');
    expect(cache).toContain('compactOrder(doc.order)');
  });

  it('keeps exact order reads live for claim/pack recovery', () => {
    const route = read('routes/baseLinker.js');
    expect(route).toContain("if (exactOrderId)");
    expect(route).toMatch(/fetchBaseLinkerOrders\([\s\S]*orderId:\s*exactOrderId[\s\S]*maxPages:\s*1/);
  });

  it('keeps the persistent cache fresh from BaseLinker journal changes', () => {
    const journal = read('services/baseLinkerJournal.js');
    expect(journal).toContain('refreshBaseLinkerOrderCache');
    expect(journal).toMatch(/refreshBaseLinkerOrderCache\(\{ orders: upserts, removedOrderIds \}\)/);
  });

  it('uses persisted operational shelf before pagination/counting with legacy status fallback', () => {
    const cache = read('services/baseLinkerOrderCache.js');
    expect(cache).toContain('localWorkflowStage');
    expect(cache).toContain("['processing', 'deferred', 'packed', 'sent']");
    expect(cache).toContain("'$localWorkflowStage'");
    expect(cache).toContain("['paused', 'problem', 'ready_to_pack_with_issue']");
    expect(cache).toContain("then: 'deferred'");
  });

  it('paginates logical fulfilment groups and exposes exact workflow counts', () => {
    const cache = read('services/baseLinkerOrderCache.js');
    expect(cache).toContain("$facet");
    expect(cache).toContain("workflowCounts");
    expect(cache).toContain("processing");
    expect(cache).toContain("deferred");
    expect(cache).toContain("packed");
    expect(cache).toContain("sent");
    expect(cache).toContain("$limit: safePageSize");
  });
});
