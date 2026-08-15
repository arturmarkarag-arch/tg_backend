const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'picking.js'), 'utf8');

describe('V44 shift-board history image contract', () => {
  test('worker-history route projects and returns a product image for every task entry', () => {
    const start = source.indexOf("router.get('/shift-board/worker-history'");
    const end = source.indexOf('router.', start + 40);
    const block = source.slice(start, end > start ? end : undefined);
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("'_id brand model category orderNumber imageUrls localImageUrl'");
    expect(block).toContain('imageUrl: (Array.isArray(product.imageUrls)');
    expect(block).toContain('imageUrl: productInfo?.imageUrl || null');
  });
});
