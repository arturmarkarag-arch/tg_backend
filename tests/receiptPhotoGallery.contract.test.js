const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'receipts.js'), 'utf8');
const { indexOrThrow, sliceBetweenOrThrow } = require('./helpers/sourceContract');

describe('receipt photo gallery contract', () => {
  test('gallery is read-only, projects the fields used by inline preparation, and is newest-first', () => {
    const gallery = sliceBetweenOrThrow(source, "router.get('/items-gallery'", "router.get('/:id'", { label: 'receipt gallery route' });
    for (const field of [
      'receiptId', 'photoUrl', 'originalPhotoUrl', 'totalQty', 'routingVersion',
      'routing', 'price', 'qtyPerPackage', 'status', 'createdBy',
    ]) expect(gallery).toContain(field);
    expect(gallery).toContain(".sort({ createdAt: -1, _id: -1 })");
  });

  test('gallery includes receipt context required below a photo and for edit navigation', () => {
    const gallery = sliceBetweenOrThrow(source, "router.get('/items-gallery'", "router.get('/:id'", { label: 'receipt gallery route' });
    expect(gallery).toContain('receiptType');
    expect(gallery).toContain('receiptTargetDeliveryGroupId');
    expect(gallery).toContain('receiptId');
  });

  test('gallery accepts the same receipt-created date range as the receipts list', () => {
    const gallery = sliceBetweenOrThrow(source, "router.get('/items-gallery'", "router.get('/:id'", { label: 'receipt gallery route' });
    expect(gallery).toContain('buildWarsawDateRange({');
    expect(gallery).toContain('dateFrom: req.query.dateFrom');
    expect(gallery).toContain('dateTo: req.query.dateTo');
    expect(gallery).not.toContain('Date.parse(req.query.dateFrom');
    expect(gallery).not.toContain('Date.parse(req.query.dateTo');
    expect(gallery).toContain("Receipt.distinct('_id', { createdAt: receiptCreatedAt })");
    expect(gallery).toContain('query.receiptId = { $in: receiptIds }');
  });

  test('gallery route is declared before /:id so Express does not swallow it as an id', () => {
    expect(indexOrThrow(source, "router.get('/items-gallery'")).toBeLessThan(indexOrThrow(source, "router.get('/:id'"));
  });
});
