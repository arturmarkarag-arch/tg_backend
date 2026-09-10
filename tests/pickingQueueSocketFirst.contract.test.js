'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('picking queue socket-first refresh contract', () => {
  it('publishes one canonical lightweight queue invalidation event', () => {
    const service = read('services/pickingService.js');
    expect(service).toContain("io?.emit('picking_queue_changed'");
    expect(service).toContain('deliveryGroupId: groupId');
    expect(service).toContain('orderingSessionId: String(orderingSessionId');
    expect(service).not.toContain("io?.emit('picking_queue_changed', {\n      buyerTelegramId");
  });

  it('covers the queue mutations that previously depended on the 5s poll', () => {
    const service = read('services/pickingService.js');
    const route = read('routes/picking.js');
    for (const reason of ["reason: 'claim'", "reason: 'release'", "reason: 'complete'", "reason: 'out_of_stock'", "reason: 'force_claim'"]) {
      expect(service).toContain(reason);
    }
    for (const reason of ["reason: 'session_confirmed'", "reason: 'session_empty'", "reason: 'cancel_start'", "reason: 'coverage_gap_resolved'"]) {
      expect(route).toContain(reason);
    }
  });

  it('keeps the previous Sentry picking N+1 repair intact', () => {
    const service = read('services/pickingService.js');
    expect(service).toContain('Order.bulkWrite(');
    expect(service).toContain('Order.updateMany(');
    expect(service).toContain("Order.find({ _id: { $in: orderIds } }, '_id buyerTelegramId'");
  });

  it('keeps releaseOtherLocksOfWorker return compatibility while notifying affected groups', () => {
    const service = read('services/pickingService.js');
    expect(service).toContain("PickingTask.find(filter, '_id deliveryGroupId orderingSessionId').lean()");
    expect(service).toContain("reason: 'previous_lock_released'");
    expect(service).toContain('return stray.map((t) => String(t._id));');
  });
});
