const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'receipts.js'), 'utf8');

describe('receipt photo gallery contract', () => {
  test('gallery is read-only and ordered by newest ReceiptItem', () => {
    expect(source).toContain("router.get('/items-gallery'");
    expect(source).toContain("ReceiptItem.find(query, '_id photoUrl')");
    expect(source).toContain(".sort({ createdAt: -1, _id: -1 })");
  });

  test('gallery route is declared before /:id so Express does not swallow it as an id', () => {
    expect(source.indexOf("router.get('/items-gallery'")).toBeLessThan(source.indexOf("router.get('/:id'"));
  });
});
