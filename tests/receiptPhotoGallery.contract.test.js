const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'receipts.js'), 'utf8');

describe('receipt photo gallery contract', () => {
  test('gallery is read-only and ordered by newest ReceiptItem', () => {
    expect(source).toContain("router.get('/items-gallery'");
    expect(source).toContain("ReceiptItem.find(query, '_id photoUrl totalQty destination receiptId')");
    expect(source).toContain(".sort({ createdAt: -1, _id: -1 })");
  });

  test('gallery returns quantity, destination and receipt type metadata', () => {
    expect(source).toContain("Receipt.find({ _id: { $in: receiptIds } }, '_id type')");
    expect(source).toContain("receiptType: receipt?.type || 'regular'");
    expect(source).toContain('items: galleryItems');
  });

  test('gallery route is declared before /:id so Express does not swallow it as an id', () => {
    expect(source.indexOf("router.get('/items-gallery'")).toBeLessThan(source.indexOf("router.get('/:id'"));
  });
});
