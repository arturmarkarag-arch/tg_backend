const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('BaseLinker minimal Intake index contract', () => {
  it('persists only queue identity/filter metadata, never a BaseLinker order payload', () => {
    const model = read('models/BaseLinkerOrderIndex.js');
    expect(model).toContain('baseLinkerAccountId:');
    expect(model).toContain('orderId:');
    expect(model).toContain('orderIdNumeric:');
    expect(model).toContain('orderSortDate:');
    expect(model).toContain('sourceType:');
    expect(model).toContain('sourceId:');
    expect(model).toContain('syncToken:');
    expect(model).toContain('seenAt:');
    expect(model).not.toContain('upstreamDisposition:');
    expect(model).not.toContain('dateInStatus:');
    expect(model).not.toMatch(/\border\s*:/);
    for (const forbidden of ['products:', 'customer', 'delivery_address', 'email:', 'phone:']) expect(model).not.toContain(forbidden);
  });

  it('scans only the configured Intake status using status_id + id_from pagination', () => {
    const service = read('services/baseLinkerOrderIndex.js');
    const orders = read('services/baseLinkerOrders.js');
    const scan = service.slice(service.indexOf('async function scanIntake'), service.indexOf('async function exactOrder'));
    expect(scan).toContain('statusId: scope.intakeStatusId');
    expect(scan).toContain('includeUnconfirmed: true');
    expect(scan).not.toContain('scope.sentStatusId');
    expect(scan).not.toContain('scope.cancelledStatusId');
    expect(orders).toContain('params.id_from = cursor');
    expect(orders).not.toContain('date_confirmed_from');
    expect(orders).not.toContain('date_from');
  });

  it('exact-checks only ids that depart Intake and keeps tracked local work/history', () => {
    const service = read('services/baseLinkerOrderIndex.js');
    expect(service).toContain('const departedIds = [...previousIds].filter((id) => !currentIds.has(id))');
    expect(service).toContain('const order = await exactOrder(scope, id)');
    expect(service).toContain('reconcilePickingFromUpstreamChanges');
    expect(service).toContain('knownAdmittedOrderIds: untrackedDeparted');
    expect(service).toContain('BaseLinkerPickingOrder');
  });

  it('leaves per-token request-budget headroom and fails closed if Intake is too large', () => {
    const service = read('services/baseLinkerOrderIndex.js');
    expect(service).toContain('const INDEX_MAX_PAGES = Math.min(60');
    expect(service).toContain("throw appError('baselinker_order_index_truncated'");
    expect(service).toContain('maxOrders: INDEX_MAX_PAGES * 100');
    expect(service).not.toContain('TERMINAL_INDEX_REFRESH_MS');
  });

  it('normalizes page input without shadowing the pagination helper', () => {
    const service = read('services/baseLinkerOrderIndex.js');
    expect(service).toContain('function normalizePage(value)');
    expect(service).toContain('const requestedPage = normalizePage(page)');
    expect(service).not.toContain('const safePage = safePage(page)');
  });

  it('does not depend on retired journal/full-order mirror runtime', () => {
    for (const rel of [
      'services/baseLinkerJournal.js',
      'services/baseLinkerOrderCache.js',
      'services/baseLinkerOrderSnapshots.js',
      'models/BaseLinkerOrderCache.js',
      'models/BaseLinkerOrderSnapshot.js',
    ]) expect(fs.existsSync(path.join(root, rel))).toBe(false);
  });
});
