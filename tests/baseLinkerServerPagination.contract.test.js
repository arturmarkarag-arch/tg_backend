const fs = require('fs');
const path = require('path');
const { sliceBetweenOrThrow } = require('./helpers/sourceContract');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('BaseLinker local-index pagination contract', () => {
  it('uses the minimal sanitized index for numbered membership/counting', () => {
    const route = read('routes/baseLinker.js');
    const index = read('services/baseLinkerOrderIndex.js');
    expect(route).toContain('getIndexedOrderPage');
    expect(route).toContain('pageSize: req.query.pageSize');
    expect(route).toContain('workflowFilter: req.query.workflowFilter');
    expect(index).toContain("BaseLinkerOrderIndex.find(mongoFilter).select('baseLinkerAccountId orderId orderIdNumeric orderSortDate sourceType sourceId preview searchText').lean()");
    expect(index).toContain('rowKeysByStage');
  });

  it('reads visible Intake rows from sanitized persisted previews without list-time BaseLinker I/O', () => {
    const index = read('services/baseLinkerOrderIndex.js');
    const pageRead = sliceBetweenOrThrow(
      index,
      'async function getIndexedOrderPage',
      'async function getLocalOrderProjection',
      { label: 'getIndexedOrderPage implementation' },
    );
    expect(pageRead).toContain('READ PATH CONTRACT: list/search/pagination is Mongo-only');
    expect(pageRead).toContain("row?.preview && typeof row.preview === 'object'");
    expect(pageRead).not.toContain('fetchBaseLinkerOrders(');
    expect(pageRead).not.toContain('liveIntakeOrdersForIds(');
  });

  it('renders already-tracked shelves from the local PickingOrder business state', () => {
    const index = read('services/baseLinkerOrderIndex.js');
    expect(index).toContain('function orderFromPicking');
    expect(index).toContain('BaseLinkerPickingOrder.find(mongoFilter).lean()');
    for (const stage of ['processing', 'deferred', 'packed', 'sent', 'cancelled', 'updated']) expect(index).toContain(stage);
  });

  it('keeps exact order reads live for critical one-order operations', () => {
    const route = read('routes/baseLinker.js');
    const picking = read('services/baseLinkerPicking.js');
    expect(route).toMatch(/fetchBaseLinkerOrders\([\s\S]*orderId:\s*exactOrderId[\s\S]*includeUnconfirmed:\s*false[\s\S]*maxPages:\s*1/);
    expect(picking).toContain('async function fetchExactOrder');
    expect(picking).toContain('includeUnconfirmed: false');
  });
});
