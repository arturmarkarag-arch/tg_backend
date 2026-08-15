const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'picking.js'), 'utf8');
const { indexOrThrow, sliceIndexesOrThrow } = require('./helpers/sourceContract');

describe('V44 shift-board history image contract', () => {
  test('worker-history route projects and returns a product image for every task entry', () => {
    const start = indexOrThrow(source, "router.get('/shift-board/worker-history'");
    const end = indexOrThrow(source, 'router.', { from: start + 40, label: 'next picking route after worker-history' });
    const block = sliceIndexesOrThrow(source, start, end, { label: 'worker-history route' });
    expect(block).toContain("'_id brand model category orderNumber imageUrls localImageUrl'");
    expect(block).toContain('imageUrl: (Array.isArray(product.imageUrls)');
    expect(block).toContain('imageUrl: productInfo?.imageUrl || null');
  });
});
