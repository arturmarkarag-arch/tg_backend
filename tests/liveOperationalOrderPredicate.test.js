'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildLiveActiveOrderFilter,
  hasLiveOrderItems,
} = require('../utils/orderStatus');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('live operational Order predicate', () => {
  it('requires both an active Order status and at least one non-terminal item', () => {
    expect(buildLiveActiveOrderFilter({ orderingSessionId: 'sid' })).toEqual({
      orderingSessionId: 'sid',
      status: { $in: ['new', 'in_progress'] },
      items: {
        $elemMatch: {
          packed: { $ne: true },
          cancelled: { $ne: true },
          skipped: { $ne: true },
          voided: { $ne: true },
        },
      },
    });
  });

  it('does not treat archived-only/cancelled shells as warehouse work', () => {
    expect(hasLiveOrderItems({ items: [{ cancelled: true }, { skipped: true }] })).toBe(false);
    expect(hasLiveOrderItems({ items: [{ voided: true }] })).toBe(false);
    expect(hasLiveOrderItems({ items: [{ packed: true }] })).toBe(false);
    expect(hasLiveOrderItems({ items: [{ cancelled: true }, { packed: false }] })).toBe(true);
  });

  it('keeps conflict discovery and task building on the shared predicate', () => {
    const picking = read('routes/picking.js');
    const orders = read('routes/orders.js');
    const taskBuilder = read('services/taskBuilder.js');

    expect(picking).toContain('buildLiveActiveOrderFilter({');
    expect(orders).toContain('Order.find(buildLiveActiveOrderFilter({');
    expect(taskBuilder).toContain('const orderFilter = buildLiveActiveOrderFilter(orderScope);');
  });

  it('pins the two live regression scenarios in the harness', () => {
    const harness = read('scripts/liveOrderPickingE2E.js');
    expect(harness).toContain("['archive_during_open_ordering', scenarioArchiveDuringOpenOrdering]");
    expect(harness).toContain("['archived_only_orders_no_conflict', scenarioArchivedOnlyOrdersNoConflict]");
    expect(harness).toContain('cancelled archived line creates NO coverage gap after task build');
    expect(harness).toContain('dead archived-only Orders do NOT create a seller conflict');
  });
});
