const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

 describe('BaseLinker minimal order-id index contract', () => {
  it('persists only queue identity/cursor metadata, never a BaseLinker order payload', () => {
    const model = read('models/BaseLinkerOrderIndex.js');
    expect(model).toContain('orderId:');
    expect(model).toContain('orderIdNumeric:');
    expect(model).toContain('upstreamDisposition:');
    expect(model).toContain('dateInStatus:');
    expect(model).toContain('syncToken:');
    expect(model).toContain('seenAt:');
    expect(model).not.toMatch(/\border\s*:/);
    for (const forbidden of ['products:', 'customer', 'delivery_address', 'email:', 'phone:']) expect(model).not.toContain(forbidden);
  });

  it('scans Intake plus bounded Sent/Cancelled history and stores no full payload', () => {
    const service = read('services/baseLinkerOrderIndex.js');
    const scan = service.slice(service.indexOf('async function scanIntake'), service.indexOf('async function exactOrder'));
    expect(scan).toContain('statusId: scope.intakeStatusId');
    expect(scan).toContain('includeUnconfirmed: true');
    expect(scan).toContain('scope.sentStatusId');
    expect(scan).toContain('scope.cancelledStatusId');
    expect(scan).toContain('orderInSentScope');
    expect(scan).toContain('orderInCancelledScope');
    expect(service).toContain('orderId: row.orderId');
    expect(service).not.toContain('order: compactOrder');
  });

  it('exact-checks only ids that depart Intake and keeps tracked local work', () => {
    const service = read('services/baseLinkerOrderIndex.js');
    expect(service).toContain('const departedIds = [...previousIds].filter((id) => !currentIds.has(id))');
    expect(service).toContain('const order = await exactOrder(id)');
    expect(service).toContain('reconcilePickingFromUpstreamChanges');
    expect(service).toContain('knownAdmittedOrderIds');
  });

  it('throttles full terminal scans and batches a selected terminal page', () => {
    const service = read('services/baseLinkerOrderIndex.js');
    expect(service).toContain('TERMINAL_INDEX_REFRESH_MS');
    expect(service).toContain('lastTerminalAttemptAt');
    expect(service).toContain('terminalAttemptAgeMs >= TERMINAL_INDEX_REFRESH_MS');
    expect(service).toContain('async function liveTerminalOrdersForIds');
    expect(service).toContain('idFrom: Math.min(...numeric)');
    expect(service).toContain('const fetchedRows = queue.rows.filter((row) => row.order)');
    expect(service).toContain('if (refreshTerminal)');
    expect(service).not.toContain('await Promise.all(ids.map(async (id)');
  });

  it('normalizes page input without shadowing the pagination helper', () => {
    const service = read('services/baseLinkerOrderIndex.js');
    expect(service).toContain('function normalizePage(value)');
    expect(service).toContain('const requestedPage = normalizePage(page)');
    expect(service).not.toContain('const safePage = safePage(page)');
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
