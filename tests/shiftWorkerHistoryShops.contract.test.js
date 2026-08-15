const fs = require('fs');
const path = require('path');

describe('V46 shift worker history keeps shop-level detail', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'picking.js'), 'utf8');

  test('worker-history returns every task shop with worker-specific marking state', () => {
    expect(route).toContain('shops,');
    expect(route).toContain('shopName: item.shopName');
    expect(route).toContain('markedByWorker');
    expect(route).toContain('packedByName: item.packedByName');
    expect(route).toContain('shopNumber: boxNumberFor(item)');
  });
});
