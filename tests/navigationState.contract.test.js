'use strict';

const fs = require('fs');
const path = require('path');

describe('mini-app navigation state contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/v1/telegram.js'), 'utf8');
  const start = source.indexOf("router.post('/mini-app/state'");
  const end = source.indexOf("router.post('/mini-app/reset-state'", start);
  const route = source.slice(start, end);

  it('keeps ordering-session mismatch as the hard concurrency guard', () => {
    expect(route).toContain('ordering_session_changed');
    expect(route).toContain("clientOrderingSessionId !== currentOrderingSessionId");
  });

  it('does not mutate legacy cart item snapshots', () => {
    expect(route).not.toContain("'cartState.orderItems'");
    expect(route).not.toContain("'cartState.orderItemIds'");
    expect(route).not.toContain('sanitizedOrderItems');
    expect(route).not.toContain('sanitizedOrderItemIds');
  });

  it('does not use cart revision stale locking', () => {
    expect(route).not.toContain('clientCartUpdatedAt');
    expect(route).not.toContain("error: 'cart_stale'");
  });

  it('does not broadcast private navigation changes to picking dashboards', () => {
    expect(route).not.toContain('shop_status_changed');
    expect(route).not.toContain('picking_group_');
  });
});
