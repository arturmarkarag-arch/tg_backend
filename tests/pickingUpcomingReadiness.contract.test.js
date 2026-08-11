const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('picking upcoming-session readiness contract', () => {
  it('publishes the next ordering opening timestamp without changing the session phase', () => {
    const source = read('routes/deliveryGroups.js');
    expect(source).toContain('nextOrderingOpenAt: getNextOrderingWindowOpenAt(g.orderingSchedule).toISOString()');
  });

  it('readiness view is assignment-only and does not materialise a future OrderingSession', () => {
    const source = read('routes/deliveryGroups.js');
    const start = source.indexOf("const readinessOnly = req.query.view === 'readiness'");
    const end = source.indexOf('const currentSessionId = await getOrCreateSessionId', start);
    const readinessBranch = source.slice(start, end);

    expect(readinessBranch).toContain("view: 'readiness'");
    expect(readinessBranch).toContain('currentSessionId: null');
    expect(readinessBranch).toContain('hasMultipleSellers: assignedStaff.length > 1');
    expect(readinessBranch).not.toContain('getOrCreateSessionId(');
    expect(readinessBranch).not.toContain('CatalogReview.find(');
    expect(readinessBranch).not.toContain('Order.find(');
  });
});
