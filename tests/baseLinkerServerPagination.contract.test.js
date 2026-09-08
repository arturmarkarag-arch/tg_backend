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
    for (const stage of ['processing', 'deferred', 'sent', 'cancelled', 'updated']) expect(index).toContain(stage);
    expect(index).toContain("=== 'packed' || String(doc?.status || '') === 'packed') return 'processing'");
    expect(index).toContain("safeWorkflow === 'sent'");
    expect(index).toContain('sentByOptions');
  });

  it('keeps worker detail reads Mongo-only while critical mutations retain exact upstream verification', () => {
    const route = read('routes/baseLinker.js');
    const picking = read('services/baseLinkerPicking.js');
    expect(route).toContain('opening an active order must consume zero');
    expect(route).not.toContain('picking_exact_read');
    expect(picking).toContain('async function fetchExactOrder');
    expect(picking).toContain('includeUnconfirmed: false');
  });
});
