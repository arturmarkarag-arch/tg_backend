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

  it('derives integrations from the single Provider Core registry', () => {
    const facade = read('services/commerce/integrationRegistry.js');
    const registry = read('services/commerce/providers/registry.js');
    expect(facade).toContain("require('./providers/registry')");
    expect(facade).not.toMatch(/listBaseLinkerAccounts|listAllegroAccounts|BaseLinkerAccount|AllegroAccount/);
    expect(registry).toContain("require('./baseLinker')");
    expect(registry).toContain("require('./allegro')");
    expect(registry).toContain('[olx.id, olx]');
    expect(registry).toContain('[temu.id, temu]');
  });

  it('exposes operational marketplace namespaces to the dedicated commerce worker role only', () => {
    const app = read('app.js');
    expect(app).toContain("req.telegramUser?.role !== 'baselinker'");
    expect(app).toContain("if (/^\\/api\\/(?:baselinker|allegro|commerce)(?:\\/|$)/.test(req.path)) return next();");
    expect(app).toContain("allowed: ['admin', 'baselinker']");
  });
});
