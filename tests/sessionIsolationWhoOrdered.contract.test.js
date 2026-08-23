'use strict';

const fs = require('fs');
const path = require('path');
const { sliceBetweenOrThrow } = require('./helpers/sourceContract');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('exact ordering-session isolation', () => {
  it('who-ordered uses exact session sections and never reads legacy cartState', () => {
    const source = read('routes/products.js');
    const route = sliceBetweenOrThrow(
      source,
      "router.get('/:id/who-ordered'",
      '// Proxy an image through the server',
      { label: 'who-ordered route' },
    );

    expect(source).toContain('orderingSessionId: String(orderingSessionId)');
    expect(route).toContain('requestedSessionId');
    expect(route).toContain('return res.json({ sections })');
    expect(route).not.toContain('currentSessionIds');
    expect(route).not.toContain('cartState');
    expect(route).not.toMatch(/orderingSessionId:\s*\{\s*\$in/);
  });

  it('conflict reads and writes require one selected group/session identity', () => {
    const source = read('routes/orders.js');
    const readRoute = sliceBetweenOrThrow(
      source,
      "router.get('/conflicts'",
      '/**\n * POST /conflicts/resolve',
      { label: 'conflict read route' },
    );
    const writeRoute = sliceBetweenOrThrow(
      source,
      "router.post('/conflicts/resolve'",
      "router.get('/',",
      { label: 'conflict resolve route' },
    );

    expect(source).toContain('requireExactConflictSession');
    expect(readRoute).toContain('orderingSessionId: sessionId');
    expect(readRoute).not.toContain('currentSessionIds');
    expect(readRoute).not.toMatch(/orderingSessionId:\s*\{\s*\$in/);
    expect(writeRoute).toContain('orderingSessionId: sessionId');
    expect(writeRoute).toContain('expectedOrderingSessionId: sessionId');

    const picking = read('routes/picking.js');
    expect(picking).toContain('orderingSessionId: String(currentSessionId)');
    expect(picking).toContain('orderingSessionId: currentSessionId ? String(currentSessionId) : null');
  });

  it('current-session shop status does not project session-less cartState as work', () => {
    const source = read('services/readModels/currentSessionShopStatusReadModel.js');
    expect(source).not.toMatch(/user\.cartState|liveSeller\?\.cartState/);
    expect(source).toContain('hasCart: false');
    expect(source).toContain('cartItemCount: cartItemsByShop[shopId] || 0');
  });
});
