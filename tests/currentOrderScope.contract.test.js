'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

describe('current seller Order projection scope', () => {
  it('uses buyer + current shop + exact current session', () => {
    const source = fs.readFileSync(path.join(ROOT, 'routes', 'orders.js'), 'utf8');
    const routeMatch = source.match(
      /router\.get\('\/current-items'[\s\S]*?(?=router\.get\('\/transit\/active')/,
    );
    expect(routeMatch).toBeTruthy();
    const route = routeMatch?.[0] || '';

    expect(route).toContain('activeOrderShopFilter(user.shopId, {');
    expect(route).toContain('buyerTelegramId: String(user.telegramId)');
    expect(route).toContain('orderingSessionId: currentSessionId');
    expect(route).toContain("status: { $in: ['new', 'in_progress'] }");
  });
});
