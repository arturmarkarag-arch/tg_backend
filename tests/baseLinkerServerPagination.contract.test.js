const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('BaseLinker ID-index pagination contract', () => {
  it('uses the minimal ID index for numbered membership/counting', () => {
    const route = read('routes/baseLinker.js');
    const index = read('services/baseLinkerOrderIndex.js');
    expect(route).toContain('getIndexedOrderPage');
    expect(route).toContain('pageSize: req.query.pageSize');
    expect(route).toContain('workflowFilter: req.query.workflowFilter');
    expect(index).toContain('BaseLinkerOrderIndex.find({})');
    expect(index).toContain('rowIdsByStage');
  });

  it('reads untouched visible Intake rows live instead of persisting payloads', () => {
    const index = read('services/baseLinkerOrderIndex.js');
    expect(index).toContain('liveIntakeOrdersForIds');
    expect(index).toContain('statusId: scope.intakeStatusId');
    expect(index).toContain('idFrom: Math.min(...numeric)');
    expect(index).toContain('includeUnconfirmed: true');
  });

  it('renders already-tracked shelves from the local PickingOrder business state', () => {
    const index = read('services/baseLinkerOrderIndex.js');
    expect(index).toContain('function orderFromPicking');
    expect(index).toContain('BaseLinkerPickingOrder.find({}).lean()');
    for (const stage of ['processing', 'deferred', 'packed', 'sent', 'cancelled', 'updated']) expect(index).toContain(stage);
  });

  it('keeps exact order reads live for critical one-order operations', () => {
    const route = read('routes/baseLinker.js');
    const picking = read('services/baseLinkerPicking.js');
    expect(route).toMatch(/fetchBaseLinkerOrders\([\s\S]*orderId:\s*exactOrderId[\s\S]*includeUnconfirmed:\s*true[\s\S]*maxPages:\s*1/);
    expect(picking).toContain('async function fetchExactOrder');
    expect(picking).toContain('includeUnconfirmed: true');
  });
});
