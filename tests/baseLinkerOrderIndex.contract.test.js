const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

 describe('BaseLinker minimal order-id index contract', () => {
  it('persists only queue identity/cursor metadata, never a BaseLinker order payload', () => {
    const model = read('models/BaseLinkerOrderIndex.js');
    expect(model).toContain('orderId:');
    expect(model).toContain('orderIdNumeric:');
    expect(model).toContain('syncToken:');
    expect(model).toContain('seenAt:');
    expect(model).not.toMatch(/\border\s*:/);
    for (const forbidden of ['products:', 'customer', 'delivery_address', 'email:', 'phone:']) expect(model).not.toContain(forbidden);
  });

  it('scans only confirmed Intake and discards full payload after extracting ids', () => {
    const service = read('services/baseLinkerOrderIndex.js');
    const scan = service.slice(service.indexOf('async function scanIntake'), service.indexOf('async function exactOrder'));
    expect(scan).toContain('statusId: scope.intakeStatusId');
    expect(scan).toContain('includeUnconfirmed: false');
    expect(scan).not.toContain('scope.sentStatusId');
    expect(scan).not.toContain('scope.cancelledStatusId');
    expect(service).toContain('orderId: String(order.order_id)');
    expect(service).not.toContain('order: compactOrder');
  });

  it('exact-checks only ids that depart Intake and keeps tracked local work', () => {
    const service = read('services/baseLinkerOrderIndex.js');
    expect(service).toContain('const departedIds = [...previousIds].filter((id) => !currentIds.has(id))');
    expect(service).toContain('const order = await exactOrder(id)');
    expect(service).toContain('reconcilePickingFromUpstreamChanges');
    expect(service).toContain('knownAdmittedOrderIds');
  });

  it('does not depend on the retired journal/full-order mirror runtime', () => {
    for (const rel of [
      'services/baseLinkerJournal.js',
      'services/baseLinkerOrderCache.js',
      'services/baseLinkerOrderSnapshots.js',
      'models/BaseLinkerOrderCache.js',
      'models/BaseLinkerOrderSnapshot.js',
    ]) expect(fs.existsSync(path.join(root, rel))).toBe(false);
  });
});
