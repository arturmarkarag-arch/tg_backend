const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'receipts.js'), 'utf8');

describe('receipt photo gallery contract', () => {
  test('gallery is read-only, projects the fields used by inline preparation, and is newest-first', () => {
    const start = source.indexOf("router.get('/items-gallery'");
    const end = source.indexOf("router.get('/:id'", start);
    const gallery = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    for (const field of [
      'receiptId', 'photoUrl', 'originalPhotoUrl', 'totalQty', 'routingVersion',
      'routing', 'price', 'qtyPerPackage', 'status', 'createdBy',
    ]) expect(gallery).toContain(field);
    expect(gallery).toContain(".sort({ createdAt: -1, _id: -1 })");
  });

  test('gallery includes receipt context required below a photo and for edit navigation', () => {
    const start = source.indexOf("router.get('/items-gallery'");
    const end = source.indexOf("router.get('/:id'", start);
    const gallery = source.slice(start, end);
    expect(gallery).toContain('receiptType');
    expect(gallery).toContain('receiptTargetDeliveryGroupId');
    expect(gallery).toContain('receiptId');
  });

  test('gallery accepts the same receipt-created date range as the receipts list', () => {
    const start = source.indexOf("router.get('/items-gallery'");
    const end = source.indexOf("router.get('/:id'", start);
    const gallery = source.slice(start, end);
    expect(gallery).toContain("Date.parse(req.query.dateFrom || '')");
    expect(gallery).toContain("Date.parse(req.query.dateTo || '')");
    expect(gallery).toContain("Receipt.distinct('_id', { createdAt: receiptCreatedAt })");
    expect(gallery).toContain('query.receiptId = { $in: receiptIds }');
  });

  test('gallery route is declared before /:id so Express does not swallow it as an id', () => {
    expect(source.indexOf("router.get('/items-gallery'")).toBeLessThan(source.indexOf("router.get('/:id'"));
  });
});
