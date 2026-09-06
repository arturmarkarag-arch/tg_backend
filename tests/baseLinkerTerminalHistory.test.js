const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('BaseLinker terminal history contract', () => {
  it('does not scan Sent/Cancelled statuses as upstream history shelves', () => {
    const index = read('services/baseLinkerOrderIndex.js');
    expect(index).toContain('async function scanIntake');
    expect(index).not.toContain('async function scanTerminalHistory');
    expect(index).not.toContain('async function scanQueue');
    expect(index).not.toContain('TERMINAL_INDEX_REFRESH_MS');
    expect(index).not.toContain('BASELINKER_TERMINAL_REFRESH_MS');
  });

  it('materializes transitions only after an Intake row departs and is reread exactly', () => {
    const index = read('services/baseLinkerOrderIndex.js');
    expect(index).toContain('const departedIds = [...previousIds].filter((id) => !currentIds.has(id))');
    expect(index).toContain('const order = await exactOrder(scope, id)');
    expect(index).toContain('classifyUpstreamOrder(order, scope)');
    expect(index).toContain('reconcilePickingFromUpstreamChanges');
    expect(index).toContain('knownAdmittedOrderIds: untrackedDeparted');
  });

  it('keeps Sent/Cancelled history in local picking state with local retention', () => {
    const indexModel = read('models/BaseLinkerOrderIndex.js');
    const pickingModel = read('models/BaseLinkerPickingOrder.js');
    const retention = read('services/baseLinkerRetention.js');
    expect(indexModel).not.toContain('upstreamDisposition:');
    expect(indexModel).not.toContain('dateInStatus:');
    expect(pickingModel).toContain('upstreamDisposition:');
    expect(retention).toContain('BASELINKER_HISTORY_RETENTION_DAYS');
  });
});
