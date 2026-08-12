'use strict';

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('multi-instance scheduler leader contract', () => {
  it('wraps every repeating scheduler in the shared distributed lock helper', () => {
    const supplement = read('services/supplementScheduler.js');
    const ordering = read('services/orderingOpenScheduler.js');
    const retention = read('services/retention.js');
    const leader = read('services/schedulerLeader.js');

    expect(leader).toContain("withLock(`scheduler:${String(name)}`");
    expect(leader).toContain('waitMs: 0');
    expect(supplement).toContain("runAsSchedulerLeader('supplement'");
    expect(ordering).toContain("runAsSchedulerLeader('ordering-open'");
    expect(retention).toContain("runAsSchedulerLeader('retention'");
  });
});
