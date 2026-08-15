'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('V48.4 live E2E fixture availability contract', () => {
  it('backdates only synthetic shelf placement before the synthetic ordering window', () => {
    for (const rel of ['scripts/liveOrderPickingE2E.js', 'scripts/liveOrderPickingMassE2E.js']) {
      const src = read(rel);
      expect(src).toContain('getOrderingWindowOpenAt');
      expect(src).toContain('availableBeforeOpen');
      expect(src).toContain('firstBlockPlacedAt: availableBeforeOpen');
      expect(src).toContain("getOrderingWindowOpenAt(openSchedule).getTime() - 60_000");
    }
  });

  it('does not weaken production product-availability logic', () => {
    const orders = read('routes/orders.js');
    expect(orders).toContain('product.firstBlockPlacedAt || product.shelvedAt || product.createdAt');
    expect(orders).toContain('new Date(availableStamp) > new Date(orderingCycleOpenAt)');
  });

  it('keeps the legacy live harness on canonical POST /api/v1/orders without inventing an upsert session fence', () => {
    const e2e = read('scripts/liveOrderPickingE2E.js');
    const mass = read('scripts/liveOrderPickingMassE2E.js');
    expect(e2e).toContain("api('POST', '/api/v1/orders', seller");
    expect(mass).toContain("api('POST', '/api/v1/orders', seller");
    expect(e2e).not.toContain("api('POST', '/api/v1/orders/upsert-item'");
    expect(mass).not.toContain("api('POST', '/api/v1/orders/upsert-item'");
  });
});
