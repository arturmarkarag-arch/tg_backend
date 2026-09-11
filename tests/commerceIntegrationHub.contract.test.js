const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('Commerce Hub integration registry', () => {
  it('mounts one provider-neutral commerce registry endpoint', () => {
    const app = read('app.js');
    const route = read('routes/commerce.js');
    expect(app).toContain("app.use('/api/commerce', commerceRouter)");
    expect(route).toContain("router.get('/integrations'");
    expect(route).toContain('requireMarketplaceWarehouseAccess');
  });

  it('keeps the registry local-only and provider-neutral', () => {
    const registry = read('services/commerce/integrationRegistry.js');
    expect(registry).toContain('listBaseLinkerAccounts');
    expect(registry).toContain('listAllegroAccounts');
    expect(registry).toContain("id: 'olx'");
    expect(registry).toContain("id: 'temu'");
    expect(registry).not.toContain('makeBaseLinkerAccountCaller');
    expect(registry).not.toContain('allegroRequest');
  });

  it('exposes operational marketplace namespaces to the dedicated commerce worker role only', () => {
    const app = read('app.js');
    expect(app).toContain("req.telegramUser?.role !== 'baselinker'");
    expect(app).toMatch(/api\\\/(?:baselinker\|allegro\|commerce)/);
    expect(app).toContain("allowed: ['admin', 'baselinker']");
  });
});
